// MarsLink: el único system propio del motor. Traduce entre el ECS de gz-sim
// y los tópicos de sim/protocol/topics.toml.
//
// Se adjunta a un modelo desde el SDF del mundo:
//
//   <plugin filename="MarsLink" name="mars::MarsLink">
//     <actuator joint="fl_drive_joint" motor="kraken_x60" gearRatio="6.75"
//               currentLimit="60" neutralMode="coast"/>
//     ...
//   </plugin>
//
// El ORDEN de los <actuator> es el contrato: es el índice dentro del campo
// `normalized` de gz.msgs.Actuators. El robot-map del bridge lista sus
// actuadores en el mismo orden, y sim/protocol/check.py verifica que las dos
// listas coincidan.

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

/// Modelo DC de un motor de FRC, el mismo que usa WPILib: el par sale de la
/// corriente, y la corriente de la diferencia entre el voltaje aplicado y la
/// fuerza contraelectromotriz. Sin esto un actuador daría par constante a
/// cualquier velocidad y el robot simulado aceleraría para siempre.
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

/// Como interpreta el actuador su comando.
///
/// `Duty` toma el valor de `normalized` (-1..1) y lo aplica tal cual.
/// `Posicion` toma `position` (radianes DEL JOINT) como consigna y cierra un PD
/// aqui, a la tasa de la fisica.
///
/// El modo posicion no es una comodidad: es la unica forma de simular un motor
/// CAN con fidelidad. Un TalonFX cierra su lazo de posicion DENTRO del
/// controlador, a ~1 kHz, y el codigo del robot solo le manda la consigna.
/// Intentar cerrar ese lazo desde el codigo del robot, sobre la red, no
/// funciona: una direccion de swerve 12.8:1 con Kraken tiene 90 N*m sobre 0.008
/// kg*m2, o sea 10700 rad/s^2, y ningun lazo a 50 Hz -- ni a 250 -- tiene
/// autoridad sobre eso.
enum class Modo
{
  Duty,
  Posicion
};

/// Que hace el motor cuando NO se le pide nada.
///
/// `Coast` es circuito abierto: no circula corriente y la rueda gira libre.
/// `Brake` cortocircuita el motor, y su propia contraelectromotriz lo frena.
///
/// Esto NO es un detalle de acabado. El modelo DC de aqui, con comando cero,
/// calcula corriente = -omega / (Kv * R), o sea que frena SIEMPRE --- estaba
/// simulando un motor en cortocircuito permanente sin haberlo elegido. Medido
/// con `bridge/src/bin/swerve-step.rs` sobre el swerve: al soltar el gas a 5.6
/// m/s el robot frenaba a 8.8 m/s^2, que es el limite de agarre de la alfombra.
/// Un frenazo de emergencia cada vez que el piloto suelta el stick se siente
/// como un robot pesadisimo, y es justo lo contrario: es un freno, no inercia.
///
/// El defecto es Coast porque es el de fabrica de un TalonFX.
enum class Neutro
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

  /// Límite de corriente de ESTATOR, en amperios. 0 = sin límite.
  ///
  /// Es la diferencia entre un motor de libro y el que lleva tu robot. Sin
  /// límite, el modelo DC entrega la corriente de calado entera --- 366 A en un
  /// Kraken --- y con eso una tracción 5.27:1 sobre ruedas de 2" da 736 N por
  /// rueda, casi seis veces el agarre que hay contra la alfombra. El robot
  /// simulado arranca patinando siempre, y el real no lo hace porque su TalonFX
  /// tiene configurado un límite que ningún lado de esta simulación conocía.
  ///
  /// El número que hay que poner es la CORRIENTE DE DESLIZAMIENTO, la misma que
  /// CTRE llama kSlipCurrent en TunerConstants: la que hace que la rueda
  /// entregue justo la fuerza que el suelo aguanta.
  ///
  ///   I_slip = mu * m * g / n_ruedas * r_rueda / (Kt * reduccion)
  ///
  /// Se aplica también a la corriente NEGATIVA, y eso no es un detalle: con
  /// duty cero el modelo frena con la contraelectromotriz entera (363 A a
  /// velocidad máxima, o sea un frenazo que ningún motor real da). El límite lo
  /// vuelve un frenado de motor de verdad.
  double currentLimit{0.0};

  Neutro neutro{Neutro::Coast};

  Modo modo{Modo::Duty};
  // Ganancias del PD de posicion, en duty por radian y por rad/s DEL JOINT.
  // Solo se usan en modo posicion.
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

  /// En lockstep, el seq del comando con el que corrio este paso.
  void EstamparSeq(gz::msgs::Header &_h)
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

  // Los callbacks de gz-transport llegan en un hilo distinto al de PreUpdate,
  // así que el buffer de comandos va bajo mutex. Es el único estado que cruza
  // hilos.
  std::mutex cmdMutex;
  std::vector<double> commands;    // normalized, para modo duty
  std::vector<double> setpoints;   // position, para modo posicion
  int matchState{0};  // 0=disabled; ver /mars/cmd/match en topics.toml

  // LOCKSTEP. Si los comandos traen header.data["seq"], cada paso de fisica
  // espera en PreUpdate al comando con el siguiente seq y PostUpdate publica
  // el estado con ese mismo seq. Asi el codigo del robot marca el paso sin
  // pausas ni servicios: un paso por comando, y el bridge sabe exactamente a
  // que comando responde cada estado. Ver bridge/src/lockstep.rs.
  std::condition_variable cmdCv;
  bool lockstep{false};
  std::uint64_t cmdSeq{0};    // el ultimo seq recibido
  std::uint64_t stepSeq{0};   // el seq con el que corrio este paso
  int esperasVacias{0};       // timeouts seguidos sin comando
  bool sawActuators{false};

  // Un reloj por topico: topics.toml declara tasas distintas y no son un
  // detalle. Las poses van a la app para dibujar, y 50 Hz sobran para eso; los
  // joints alimentan los encoders del codigo del robot, cuyo ciclo es de 20 ms,
  // y ahi 200 Hz garantiza que nunca lea un valor de mas de un paso de antiguedad.
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
  for (auto el = sdf->GetElement("actuator"); el;
       el = el->GetNextElement("actuator"))
  {
    Actuator a;
    a.jointName = el->Get<std::string>("joint", "").first;
    a.gearRatio = el->Get<double>("gearRatio", 1.0).first;
    a.inverted = el->Get<bool>("inverted", false).first;

    const auto motorName = el->Get<std::string>("motor", "kraken_x60").first;
    const auto it = kMotors.find(motorName);
    if (it == kMotors.end())
    {
      gzerr << "[MarsLink] unknown motor: " << motorName << std::endl;
      return;
    }
    a.motor = it->second;

    a.currentLimit = el->Get<double>("currentLimit", 0.0).first;
    if (a.currentLimit < 0.0)
    {
      gzerr << "[MarsLink] currentLimit cannot be negative: " << a.currentLimit
            << std::endl;
      return;
    }

    const auto neutro = el->Get<std::string>("neutralMode", "coast").first;
    if (neutro == "coast")
    {
      a.neutro = Neutro::Coast;
    }
    else if (neutro == "brake")
    {
      a.neutro = Neutro::Brake;
    }
    else
    {
      gzerr << "[MarsLink] unknown neutralMode: " << neutro
            << " (expected coast or brake)" << std::endl;
      return;
    }

    const auto modo = el->Get<std::string>("control", "duty").first;
    if (modo == "duty")
    {
      a.modo = Modo::Duty;
    }
    else if (modo == "position")
    {
      a.modo = Modo::Posicion;
      a.kp = el->Get<double>("kp", 0.1).first;
      a.kd = el->Get<double>("kd", 0.01).first;
    }
    else
    {
      gzerr << "[MarsLink] unknown control mode: " << modo
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

    // Sin crear estos componentes el ECS no calcula posición ni velocidad de
    // joint, y PostUpdate publicaría ceros sin ningún error visible.
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

  size_t enPosicion = 0;
  size_t conLimite = 0;
  for (const auto &a : this->actuators)
  {
    if (a.modo == Modo::Posicion)
      ++enPosicion;
    if (a.currentLimit > 0.0)
      ++conLimite;
  }
  gzmsg << "[MarsLink] protocol " << kProtocolVersion << ", "
        << this->actuators.size() << " actuators (" << enPosicion
        << " in position mode, " << conLimite << " current limited)"
        << std::endl;
  if (conLimite < this->actuators.size())
  {
    // Un actuador sin limite entrega la corriente de calado entera. Para una
    // traccion son varias veces el agarre disponible: el robot arranca
    // patinando y nadie sabe por que.
    gzwarn << "[MarsLink] " << (this->actuators.size() - conLimite)
           << " actuator(s) without currentLimit: they will deliver full stall"
              " current, which no real motor controller allows"
           << std::endl;
  }
}

void MarsLink::OnActuators(const gz::msgs::Actuators &_msg)
{
  // Solo el primero: confirma que el camino de comandos cruza de verdad. Un
  // log por mensaje a 200 Hz seria inutilizable.
  if (!this->sawActuators)
  {
    this->sawActuators = true;
    gzmsg << "[MarsLink] first /mars/cmd/actuators: "
          << _msg.normalized_size() << " values" << std::endl;
  }

  std::lock_guard<std::mutex> lock(this->cmdMutex);

  // Los tres campos de gz.msgs.Actuators comparten indexacion. Cada actuador
  // lee el que le toca segun su modo; el bridge llena solo el que corresponde,
  // asi que el otro llega vacio o en cero y se ignora.
  const int n = std::min<int>(_msg.normalized_size(),
                              static_cast<int>(this->commands.size()));
  for (int i = 0; i < n; ++i)
    this->commands[i] = std::clamp(_msg.normalized(i), -1.0, 1.0);

  const int m = std::min<int>(_msg.position_size(),
                              static_cast<int>(this->setpoints.size()));
  for (int i = 0; i < m; ++i)
    this->setpoints[i] = _msg.position(i);

  // LOCKSTEP: un comando con seq despierta al paso que lo espera en
  // PreUpdate. Un seq repetido (el bridge reenvia si no ve respuesta) no
  // cuenta como comando nuevo, asi que no se cuela un paso de mas.
  for (const auto &d : _msg.header().data())
  {
    if (d.key() == "seq" && d.value_size() > 0)
    {
      const std::uint64_t seq = std::stoull(d.value(0));
      if (seq < this->cmdSeq)
      {
        // Un seq MENOR es un bridge nuevo que empieza a contar de 1 sobre un
        // mundo que siguio vivo: se reinicia la cuenta para no ignorarlo.
        this->stepSeq = seq - 1;
      }
      this->cmdSeq = seq;
      if (!this->lockstep)
      {
        this->lockstep = true;
        gzmsg << "[MarsLink] lockstep: physics now waits for each command"
              << std::endl;
      }
      this->esperasVacias = 0;
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
      // Espera acotada: si el robot se va (fin de un test, recompilar) el
      // mundo no puede quedarse colgado para siempre. Tres esperas vacias
      // seguidas y se vuelve a correr libre hasta el proximo comando con seq.
      const bool hay = this->cmdCv.wait_for(
          lock, std::chrono::seconds(1),
          [this] { return this->cmdSeq > this->stepSeq; });
      if (hay)
      {
        this->stepSeq = this->cmdSeq;
      }
      else if (++this->esperasVacias >= 3)
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

    // El comando en bruto: duty directo, o el que sale del PD de posicion.
    double v = 0.0;
    if (a.modo == Modo::Duty)
    {
      v = duty[i];
    }
    else
    {
      // PD cerrado AQUI, a la tasa de la fisica. La derivada sale de la
      // velocidad medida y no de derivar el error: derivar numericamente un
      // error que llega por la red amplifica cualquier salto de la consigna.
      v = a.kp * (target[i] - posJoint) - a.kd * omegaJoint;
    }

    // Deshabilitado significa par cero, no "mantener el último comando" ni
    // "seguir sujetando la posicion". Un robot real con el Driver Station
    // deshabilitado rueda libre, y las direcciones de un swerve quedan sueltas;
    // simular lo contrario esconde bugs de arranque.
    if (!enabled)
      v = 0.0;
    if (a.inverted)
      v = -v;
    v = std::clamp(v, -1.0, 1.0);

    // Neutro: sin comando y en coast, el controlador abre el circuito y no
    // circula corriente. Sin este caso el motor frena por contraelectromotriz
    // aunque nadie se lo haya pedido --- incluso con el robot deshabilitado,
    // que es cuando mas claro esta que tiene que rodar libre.
    if (a.neutro == Neutro::Coast && std::abs(v) < 1e-3)
    {
      _ecm.SetComponentData<gz::sim::components::JointForceCmd>(a.joint, {0.0});
      continue;
    }

    const double omegaMotor = omegaJoint * a.gearRatio;
    const double volts = v * kNominalVoltage;
    double current =
        (volts - omegaMotor / a.motor.Kv()) / a.motor.Resistance();

    // El límite de estator, que es lo que hace que el robot simulado arranque
    // como el real en vez de quemando rueda. Recortar la CORRIENTE y no el par
    // es lo correcto: un controlador de verdad lo consigue bajando el voltaje,
    // y el par sale de la corriente, así que recortarla aquí da exactamente el
    // mismo par que daría ese voltaje menor.
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

  // Las tasas salen de topics.toml. La fisica corre a 250 Hz; publicar en cada
  // paso gastaria ancho de banda sin darle al bridge nada que no tuviera ya.
  //
  // Las dos a 4 ms, o sea UNA por paso de fisica. Con 5 ms los joints salian
  // cada DOS pasos (8 ms = 125 Hz, medido): 4 ms no alcanza el umbral de 5 y el
  // mensaje se saltaba un paso. En lockstep el bridge espera el estado de cada
  // paso, asi que saltarse uno lo dejaba colgado; y en tiempo real el lazo de
  // velocidad del TalonFX, que corre en el robot, recibia los encoders con un
  // paso extra de retraso. La pose tambien va por paso: el yaw del giroscopio
  // simulado sale de ella.
  const auto kPosePeriod = std::chrono::milliseconds(4);     // 250 Hz
  const auto kJointsPeriod = std::chrono::milliseconds(4);   // 250 Hz

  const bool tocaPose = _info.simTime - this->lastPose >= kPosePeriod;
  const bool tocaJoints = _info.simTime - this->lastJoints >= kJointsPeriod;
  if (!tocaPose && !tocaJoints)
    return;

  const auto stamp = gz::msgs::Convert(_info.simTime);

  // --- poses de los links -------------------------------------------------
  if (tocaPose)
  {
    this->lastPose = _info.simTime;

    gz::msgs::Pose_V poses;
    *poses.mutable_header()->mutable_stamp() = stamp;
    this->EstamparSeq(*poses.mutable_header());
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

  // --- estado de los joints -----------------------------------------------
  if (!tocaJoints)
    return;
  this->lastJoints = _info.simTime;

  gz::msgs::Model joints;
  *joints.mutable_header()->mutable_stamp() = stamp;
  this->EstamparSeq(*joints.mutable_header());
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
