// MarsLink: the engine's only system of our own. Translates between gz-sim's
// ECS and the topics of sim/protocol/topics.toml.
//
// It is attached to a model from the world's SDF:
//
//   <plugin filename="MarsLink" name="mars::MarsLink">
//     <actuator joint="fl_drive_joint" motor="kraken_x60" gearRatio="6.75"
//               currentLimit="60" neutralMode="coast"/>
//     ...
//   </plugin>
//
// The ORDER of the <actuator> elements is the contract: it is the index inside
// gz.msgs.Actuators' `normalized` field. The bridge's robot-map lists its
// actuators in the same order, and sim/protocol/check.py verifies that both
// lists match.

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include <gz/msgs/actuators.pb.h>
#include <gz/msgs/int32.pb.h>
#include <gz/msgs/model.pb.h>
#include <gz/msgs/pose_v.pb.h>
#include <gz/msgs/stringmsg.pb.h>

#include <gz/common/Console.hh>
#include <gz/msgs/Utility.hh>
#include <gz/plugin/Register.hh>
#include <gz/transport/Node.hh>

#include <gz/sim/Model.hh>
#include <gz/sim/System.hh>
#include <gz/sim/Util.hh>
#include <gz/sim/components/JointForceCmd.hh>
#include <gz/sim/components/JointPosition.hh>
#include <gz/sim/components/JointVelocity.hh>
#include <gz/sim/components/Name.hh>

namespace mars
{
constexpr const char *kProtocolVersion = "0.1.0";
constexpr double kNominalVoltage = 12.0;

/// DC model of an FRC motor, the same one WPILib uses: the torque comes from the
/// current, and the current from the difference between the applied voltage and
/// the back-EMF. Without this an actuator would give constant torque at any
/// speed and the simulated robot would accelerate forever.
struct Motor
{
  double stallTorque{0.0};   // Nm
  double stallCurrent{1.0};  // A
  double freeSpeed{1.0};     // rad/s
  double freeCurrent{0.0};   // A

  double Resistance() const { return kNominalVoltage / this->stallCurrent; }
  double Kt() const { return this->stallTorque / this->stallCurrent; }
  double Kv() const
  {
    return this->freeSpeed /
           (kNominalVoltage - this->freeCurrent * this->Resistance());
  }
};

/// RPM a rad/s.
constexpr double Rpm(double _v) { return _v * 0.10471975511965977; }

const std::unordered_map<std::string, Motor> kMotors = {
  {"kraken_x60", {7.09, 366.0, Rpm(6000.0), 2.0}},
  {"falcon500",  {4.69, 257.0, Rpm(6380.0), 1.5}},
  {"neo",        {3.28, 181.0, Rpm(5676.0), 1.3}},
  {"neo550",     {1.08, 111.0, Rpm(11000.0), 1.1}},
  {"cim",        {2.41, 131.0, Rpm(5330.0), 2.7}},
};

/// How the actuator interprets its command.
///
/// `Duty` takes the value of `normalized` (-1..1) and applies it as is.
/// `Position` takes `position` (JOINT radians) as the setpoint and closes a PD
/// here, at the physics rate.
///
/// Position mode is not a convenience: it is the only way to simulate a CAN
/// motor faithfully. A TalonFX closes its position loop INSIDE the controller,
/// at ~1 kHz, and the robot code only sends it the setpoint. Trying to close
/// that loop from the robot code, over the network, does not work: a 12.8:1
/// swerve steer with a Kraken has 90 N*m over 0.008 kg*m2, i.e. 10700 rad/s^2,
/// and no loop at 50 Hz -- nor at 250 -- has authority over that.
enum class ControlMode
{
  Duty,
  Position
};

/// What the motor does when NOTHING is asked of it.
///
/// `Coast` is an open circuit: no current flows and the wheel spins free.
/// `Brake` shorts the motor, and its own back-EMF brakes it.
///
/// This is NOT a finishing detail. The DC model here, with a zero command,
/// computes current = -omega / (Kv * R), i.e. it ALWAYS brakes --- it was
/// simulating a permanently shorted motor without having chosen to. Measured
/// with `bridge/src/bin/swerve-step.rs` on the swerve: letting off the throttle
/// at 5.6 m/s the robot braked at 8.8 m/s^2, which is the carpet's grip limit.
/// An emergency stop every time the driver lets go of the stick feels like a
/// very heavy robot, and it is exactly the opposite: it is a brake, not inertia.
///
/// The default is Coast because it is a TalonFX's factory default.
enum class NeutralMode
{
  Coast,
  Brake
};

struct Actuator
{
  std::string jointName;
  gz::sim::Entity joint{gz::sim::kNullEntity};
  Motor motor;
  double gearRatio{1.0};
  bool inverted{false};

  /// STATOR current limit, in amps. 0 = no limit.
  ///
  /// It is the difference between a textbook motor and the one on your robot.
  /// Without a limit, the DC model delivers the whole stall current --- 366 A on
  /// a Kraken --- and with that a 5.27:1 drive on 2" wheels gives 736 N per
  /// wheel, almost six times the grip there is against the carpet. The simulated
  /// robot always starts out slipping, and the real one does not because its
  /// TalonFX has a configured limit that no side of this simulation knew about.
  ///
  /// The number to put here is the SLIP CURRENT, the same one CTRE calls
  /// kSlipCurrent in TunerConstants: the one that makes the wheel deliver just
  /// the force the floor can take.
  ///
  ///   I_slip = mu * m * g / n_wheels * r_wheel / (Kt * reduction)
  ///
  /// It also applies to NEGATIVE current, and that is not a detail: with zero
  /// duty the model brakes with the whole back-EMF (363 A at top speed, i.e. a
  /// stop no real motor gives). The limit turns it into real motor braking.
  double currentLimit{0.0};

  NeutralMode neutral{NeutralMode::Coast};

  ControlMode mode{ControlMode::Duty};
  // Position PD gains, in duty per JOINT radian and per JOINT rad/s.
  // Only used in position mode.
  double kp{0.1};
  double kd{0.01};
};

class MarsLink : public gz::sim::System,
                 public gz::sim::ISystemConfigure,
                 public gz::sim::ISystemPreUpdate,
                 public gz::sim::ISystemPostUpdate
{
public:
  void Configure(const gz::sim::Entity &_entity,
                 const std::shared_ptr<const sdf::Element> &_sdf,
                 gz::sim::EntityComponentManager &_ecm,
                 gz::sim::EventManager &_eventMgr) override;

  void PreUpdate(const gz::sim::UpdateInfo &_info,
                 gz::sim::EntityComponentManager &_ecm) override;

  void PostUpdate(const gz::sim::UpdateInfo &_info,
                  const gz::sim::EntityComponentManager &_ecm) override;

private:
  void OnActuators(const gz::msgs::Actuators &_msg);

  /// In lockstep, the seq of the command this step ran with.
  void StampSeq(gz::msgs::Header &_h)
  {
    std::lock_guard<std::mutex> lock(this->cmdMutex);
    if (!this->lockstep)
      return;
    auto *d = _h.add_data();
    d->set_key("seq");
    d->add_value(std::to_string(this->stepSeq));
  }
  void OnMatch(const gz::msgs::Int32 &_msg);

  gz::sim::Model model{gz::sim::kNullEntity};
  std::vector<Actuator> actuators;

  gz::transport::Node node;
  gz::transport::Node::Publisher posePub;
  gz::transport::Node::Publisher jointPub;
  gz::transport::Node::Publisher helloPub;

  // gz-transport's callbacks arrive on a different thread than PreUpdate's, so
  // the command buffer is under a mutex. It is the only state that crosses
  // threads.
  std::mutex cmdMutex;
  std::vector<double> commands;    // normalized, for duty mode
  std::vector<double> setpoints;   // position, for position mode
  int matchState{0};  // 0=disabled; ver /mars/cmd/match en topics.toml

  // LOCKSTEP. If the commands carry header.data["seq"], each physics step
  // waits in PreUpdate for the command with the next seq and PostUpdate
  // publishes the state with that same seq. That way the robot code sets the
  // pace with no pauses or services: one step per command, and the bridge
  // knows exactly which command each state answers. See bridge/src/lockstep.rs.
  std::condition_variable cmdCv;
  bool lockstep{false};
  std::uint64_t cmdSeq{0};    // the last seq received
  std::uint64_t stepSeq{0};   // the seq this step ran with
  int emptyWaits{0};       // consecutive timeouts without a command
  bool sawActuators{false};

  // One clock per topic: topics.toml declares different rates and they are not
  // a detail. The poses go to the app for drawing, and 50 Hz is plenty for that;
  // the joints feed the robot code's encoders, whose cycle is 20 ms, and there
  // 200 Hz guarantees it never reads a value more than one step old.
  std::chrono::steady_clock::duration lastPose{0};
  std::chrono::steady_clock::duration lastJoints{0};
};

void MarsLink::Configure(const gz::sim::Entity &_entity,
                         const std::shared_ptr<const sdf::Element> &_sdf,
                         gz::sim::EntityComponentManager &_ecm,
                         gz::sim::EventManager &)
{
  this->model = gz::sim::Model(_entity);
  if (!this->model.Valid(_ecm))
  {
    gzerr << "[MarsLink] must be attached to a model" << std::endl;
    return;
  }

  auto sdf = _sdf->Clone();
  for (auto elem = sdf->GetElement("actuator"); elem;
       elem = elem->GetNextElement("actuator"))
  {
    Actuator a;
    a.jointName = elem->Get<std::string>("joint", "").first;
    a.gearRatio = elem->Get<double>("gearRatio", 1.0).first;
    a.inverted = elem->Get<bool>("inverted", false).first;

    const auto motorName = elem->Get<std::string>("motor", "kraken_x60").first;
    const auto it = kMotors.find(motorName);
    if (it == kMotors.end())
    {
      gzerr << "[MarsLink] unknown motor: " << motorName << std::endl;
      return;
    }
    a.motor = it->second;

    a.currentLimit = elem->Get<double>("currentLimit", 0.0).first;
    if (a.currentLimit < 0.0)
    {
      gzerr << "[MarsLink] currentLimit cannot be negative: " << a.currentLimit
            << std::endl;
      return;
    }

    const auto neutral = elem->Get<std::string>("neutralMode", "coast").first;
    if (neutral == "coast")
    {
      a.neutral = NeutralMode::Coast;
    }
    else if (neutral == "brake")
    {
      a.neutral = NeutralMode::Brake;
    }
    else
    {
      gzerr << "[MarsLink] unknown neutralMode: " << neutral
            << " (expected coast or brake)" << std::endl;
      return;
    }

    const auto mode = elem->Get<std::string>("control", "duty").first;
    if (mode == "duty")
    {
      a.mode = ControlMode::Duty;
    }
    else if (mode == "position")
    {
      a.mode = ControlMode::Position;
      a.kp = elem->Get<double>("kp", 0.1).first;
      a.kd = elem->Get<double>("kd", 0.01).first;
    }
    else
    {
      gzerr << "[MarsLink] unknown control mode: " << mode
            << " (expected duty or position)" << std::endl;
      return;
    }

    a.joint = this->model.JointByName(_ecm, a.jointName);
    if (a.joint == gz::sim::kNullEntity)
    {
      gzerr << "[MarsLink] joint does not exist in the model: " << a.jointName
            << std::endl;
      return;
    }

    // Without creating these components the ECS does not compute joint position
    // or velocity, and PostUpdate would publish zeros without any visible error.
    if (!_ecm.Component<gz::sim::components::JointPosition>(a.joint))
      _ecm.CreateComponent(a.joint, gz::sim::components::JointPosition());
    if (!_ecm.Component<gz::sim::components::JointVelocity>(a.joint))
      _ecm.CreateComponent(a.joint, gz::sim::components::JointVelocity());

    this->actuators.push_back(a);
  }

  this->commands.assign(this->actuators.size(), 0.0);
  this->setpoints.assign(this->actuators.size(), 0.0);

  this->posePub = this->node.Advertise<gz::msgs::Pose_V>("/mars/state/pose");
  this->jointPub = this->node.Advertise<gz::msgs::Model>("/mars/state/joints");
  this->helloPub =
      this->node.Advertise<gz::msgs::StringMsg>("/mars/meta/hello");

  this->node.Subscribe("/mars/cmd/actuators", &MarsLink::OnActuators, this);
  this->node.Subscribe("/mars/cmd/match", &MarsLink::OnMatch, this);

  size_t inPosition = 0;
  size_t withLimit = 0;
  for (const auto &a : this->actuators)
  {
    if (a.mode == ControlMode::Position)
      ++inPosition;
    if (a.currentLimit > 0.0)
      ++withLimit;
  }
  gzmsg << "[MarsLink] protocol " << kProtocolVersion << ", "
        << this->actuators.size() << " actuators (" << inPosition
        << " in position mode, " << withLimit << " current limited)"
        << std::endl;
  if (withLimit < this->actuators.size())
  {
    // An actuator without a limit delivers the whole stall current. For a drive
    // that is several times the available grip: the robot starts out slipping
    // and nobody knows why.
    gzwarn << "[MarsLink] " << (this->actuators.size() - withLimit)
           << " actuator(s) without currentLimit: they will deliver full stall"
              " current, which no real motor controller allows"
           << std::endl;
  }
}

void MarsLink::OnActuators(const gz::msgs::Actuators &_msg)
{
  // Only the first one: it confirms the command path really goes through. A
  // log per message at 200 Hz would be unusable.
  if (!this->sawActuators)
  {
    this->sawActuators = true;
    gzmsg << "[MarsLink] first /mars/cmd/actuators: "
          << _msg.normalized_size() << " values" << std::endl;
  }

  std::lock_guard<std::mutex> lock(this->cmdMutex);

  // The three fields of gz.msgs.Actuators share indexing. Each actuator reads
  // the one its mode calls for; the bridge only fills the matching one, so the
  // other arrives empty or zeroed and is ignored.
  const int n = std::min<int>(_msg.normalized_size(),
                              static_cast<int>(this->commands.size()));
  for (int i = 0; i < n; ++i)
    this->commands[i] = std::clamp(_msg.normalized(i), -1.0, 1.0);

  const int m = std::min<int>(_msg.position_size(),
                              static_cast<int>(this->setpoints.size()));
  for (int i = 0; i < m; ++i)
    this->setpoints[i] = _msg.position(i);

  // LOCKSTEP: a command with a seq wakes the step waiting for it in
  // PreUpdate. A repeated seq (the bridge resends if it sees no response) does
  // not count as a new command, so no extra step slips in.
  for (const auto &d : _msg.header().data())
  {
    if (d.key() == "seq" && d.value_size() > 0)
    {
      const std::uint64_t seq = std::stoull(d.value(0));
      if (seq < this->cmdSeq)
      {
        // A LOWER seq is a new bridge that starts counting from 1 on a world
        // that stayed alive: the count is reset so it is not ignored.
        this->stepSeq = seq - 1;
      }
      this->cmdSeq = seq;
      if (!this->lockstep)
      {
        this->lockstep = true;
        gzmsg << "[MarsLink] lockstep: physics now waits for each command"
              << std::endl;
      }
      this->emptyWaits = 0;
      this->cmdCv.notify_all();
      break;
    }
  }
}

void MarsLink::OnMatch(const gz::msgs::Int32 &_msg)
{
  gzmsg << "[MarsLink] /mars/cmd/match = " << _msg.data() << std::endl;
  std::lock_guard<std::mutex> lock(this->cmdMutex);
  this->matchState = _msg.data();
}

void MarsLink::PreUpdate(const gz::sim::UpdateInfo &_info,
                         gz::sim::EntityComponentManager &_ecm)
{
  if (_info.paused)
    return;

  std::vector<double> duty;
  std::vector<double> target;
  bool enabled = false;
  {
    std::unique_lock<std::mutex> lock(this->cmdMutex);
    if (this->lockstep)
    {
      // A bounded wait: if the robot goes away (end of a test, a rebuild) the
      // world cannot stay hung forever. Three empty waits in a row and it goes
      // back to running free until the next command with a seq.
      const bool got = this->cmdCv.wait_for(
          lock, std::chrono::seconds(1),
          [this] { return this->cmdSeq > this->stepSeq; });
      if (got)
      {
        this->stepSeq = this->cmdSeq;
      }
      else if (++this->emptyWaits >= 3)
      {
        this->lockstep = false;
        gzmsg << "[MarsLink] lockstep: no commands for 3 s, running free"
              << std::endl;
      }
    }
    duty = this->commands;
    target = this->setpoints;
    enabled = this->matchState != 0 && this->matchState != 4;
  }

  for (size_t i = 0; i < this->actuators.size(); ++i)
  {
    const auto &a = this->actuators[i];

    double omegaJoint = 0.0;
    if (const auto *comp =
            _ecm.Component<gz::sim::components::JointVelocity>(a.joint);
        comp != nullptr && !comp->Data().empty())
    {
      omegaJoint = comp->Data()[0];
    }

    double posJoint = 0.0;
    if (const auto *comp =
            _ecm.Component<gz::sim::components::JointPosition>(a.joint);
        comp != nullptr && !comp->Data().empty())
    {
      posJoint = comp->Data()[0];
    }

    // The raw command: duty directly, or the one coming out of the position PD.
    double v = 0.0;
    if (a.mode == ControlMode::Duty)
    {
      v = duty[i];
    }
    else
    {
      // PD closed HERE, at the physics rate. The derivative comes from the
      // measured velocity and not from differentiating the error: numerically
      // differentiating an error that arrives over the network amplifies any
      // jump in the setpoint.
      v = a.kp * (target[i] - posJoint) - a.kd * omegaJoint;
    }

    // Disabled means zero torque, not "keep the last command" nor "keep holding
    // the position". A real robot with the Driver Station disabled rolls free,
    // and a swerve's steers go loose; simulating the opposite hides startup bugs.
    if (!enabled)
      v = 0.0;
    if (a.inverted)
      v = -v;
    v = std::clamp(v, -1.0, 1.0);

    // Neutral: with no command and in coast, the controller opens the circuit
    // and no current flows. Without this case the motor brakes by back-EMF even
    // though nobody asked it to --- even with the robot disabled, which is when
    // it is clearest that it has to roll free.
    if (a.neutral == NeutralMode::Coast && std::abs(v) < 1e-3)
    {
      _ecm.SetComponentData<gz::sim::components::JointForceCmd>(a.joint, {0.0});
      continue;
    }

    const double omegaMotor = omegaJoint * a.gearRatio;
    const double volts = v * kNominalVoltage;
    double current =
        (volts - omegaMotor / a.motor.Kv()) / a.motor.Resistance();

    // The stator limit, which is what makes the simulated robot start like the
    // real one instead of burning rubber. Clipping the CURRENT and not the torque
    // is right: a real controller achieves it by lowering the voltage, and the
    // torque comes from the current, so clipping it here gives exactly the same
    // torque that lower voltage would.
    if (a.currentLimit > 0.0)
      current = std::clamp(current, -a.currentLimit, a.currentLimit);

    const double torque = a.motor.Kt() * current * a.gearRatio;

    _ecm.SetComponentData<gz::sim::components::JointForceCmd>(a.joint,
                                                              {torque});
  }
}

void MarsLink::PostUpdate(const gz::sim::UpdateInfo &_info,
                          const gz::sim::EntityComponentManager &_ecm)
{
  if (_info.paused)
    return;

  // The rates come from topics.toml. The physics runs at 250 Hz; publishing
  // every step would spend bandwidth without giving the bridge anything it did
  // not already have.
  //
  // Both at 4 ms, i.e. ONE per physics step. With 5 ms the joints went out
  // every TWO steps (8 ms = 125 Hz, measured): 4 ms does not reach the 5
  // threshold and the message skipped a step. In lockstep the bridge waits for
  // every step's state, so skipping one left it hung; and in real time the
  // TalonFX's velocity loop, which runs on the robot, got the encoders one
  // extra step late. The pose also goes once per step: the simulated gyro's
  // yaw comes from it.
  const auto kPosePeriod = std::chrono::milliseconds(4);     // 250 Hz
  const auto kJointsPeriod = std::chrono::milliseconds(4);   // 250 Hz

  const bool poseDue = _info.simTime - this->lastPose >= kPosePeriod;
  const bool jointsDue = _info.simTime - this->lastJoints >= kJointsPeriod;
  if (!poseDue && !jointsDue)
    return;

  const auto stamp = gz::msgs::Convert(_info.simTime);

  // --- link poses -------------------------------------------------
  if (poseDue)
  {
    this->lastPose = _info.simTime;

    gz::msgs::Pose_V poses;
    *poses.mutable_header()->mutable_stamp() = stamp;
    this->StampSeq(*poses.mutable_header());
    for (const auto link : this->model.Links(_ecm))
    {
      const auto *name = _ecm.Component<gz::sim::components::Name>(link);
      if (name == nullptr)
        continue;
      auto *p = poses.add_pose();
      p->set_name(name->Data());
      p->set_id(link);
      gz::msgs::Set(p, gz::sim::worldPose(link, _ecm));
    }
    this->posePub.Publish(poses);
  }

  // --- joint state -----------------------------------------------
  if (!jointsDue)
    return;
  this->lastJoints = _info.simTime;

  gz::msgs::Model joints;
  *joints.mutable_header()->mutable_stamp() = stamp;
  this->StampSeq(*joints.mutable_header());
  joints.set_name(this->model.Name(_ecm));
  for (const auto &a : this->actuators)
  {
    auto *j = joints.add_joint();
    j->set_name(a.jointName);

    if (const auto *pos =
            _ecm.Component<gz::sim::components::JointPosition>(a.joint);
        pos != nullptr && !pos->Data().empty())
    {
      j->mutable_axis1()->set_position(pos->Data()[0]);
    }
    if (const auto *vel =
            _ecm.Component<gz::sim::components::JointVelocity>(a.joint);
        vel != nullptr && !vel->Data().empty())
    {
      j->mutable_axis1()->set_velocity(vel->Data()[0]);
    }
  }
  this->jointPub.Publish(joints);
}
}  // namespace mars

GZ_ADD_PLUGIN(mars::MarsLink,
              gz::sim::System,
              mars::MarsLink::ISystemConfigure,
              mars::MarsLink::ISystemPreUpdate,
              mars::MarsLink::ISystemPostUpdate)
GZ_ADD_PLUGIN_ALIAS(mars::MarsLink, "mars::MarsLink")
