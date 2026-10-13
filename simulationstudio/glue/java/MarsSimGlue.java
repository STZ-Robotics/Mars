// Copiar a src/main/java/frc/robot/modules/swerve/MarsSimGlue.java
//
// Qué es
// ======
// Cambia el motor de simulación del swerve. CTRE simula los módulos con
// cinemática: integra la pose a partir de las velocidades que pide el código.
// No hay fricción, ni masa, ni colisiones --- el robot atraviesa las paredes.
//
// Esta clase sustituye esa simulación por la de Gazebo. El robot pasa a tener
// masa, las ruedas patinan, y si choca contra algo se para.
//
// Lo que NO cambia
// ================
// NADA de tu lógica de swerve. TunerConstants, SwerveRequestFactory,
// DriverBindings, las ganancias de Slot0Configs: todo igual. No hay una segunda
// implementación del swerve en ningún sitio. Lo único que cambia es de dónde
// salen los valores de los encoders.
//
// Y si el Studio no está corriendo, esta clase se aparta sola y deja que CTRE
// simule como siempre. Trabajar sin la simulación no requiere tocar nada.
//
// Lockstep
// ========
// Con la variable de entorno MARS_LOCKSTEP=127.0.0.1:5811 (y el bridge con
// --lockstep-port 5811 sobre un mundo con real_time_factor 0) el robot deja de
// correr en tiempo real: el tiempo de WPILib se pausa y avanza un paso de
// física a la vez. Cada corrida sale igual (±0.6% medido, contra ±10% en tiempo
// real) y va a ~1.1x tiempo real. MARS_LOCKSTEP_SETTLE_MS (2.5 por defecto)
// cambia velocidad por fidelidad: 1.0 va a ~2x con un sesgo de ~10%.
//
// Usa NetworkIO de ForgeMini para todo el tráfico de NT, no la API cruda: es la
// convención del proyecto y ya está probada en él.

package frc.robot.modules.swerve;

import static edu.wpi.first.units.Units.Degrees;
import static edu.wpi.first.units.Units.Rotations;
import static edu.wpi.first.units.Units.RotationsPerSecond;

import com.ctre.phoenix6.Utils;
import com.ctre.phoenix6.hardware.CANcoder;
import com.ctre.phoenix6.hardware.TalonFX;
import com.ctre.phoenix6.sim.ChassisReference;
import com.ctre.phoenix6.swerve.SwerveDrivetrain;
import com.stzteam.forgemini.io.NetworkIO;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.networktables.StructPublisher;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.RobotController;
import edu.wpi.first.wpilibj.simulation.SimHooks;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import frc.robot.configuration.constants.TunerConstants;

public final class MarsSimGlue {
  /** Tablas del contrato. Ver sim/protocol/topics.toml, sección [[glue]]. */
  private static final String SALIDA = "MARS/Glue/out";
  private static final String ENTRADA = "MARS/Glue/in";
  /** Diagnóstico del propio glue: dice si esta clase vive y si su hilo corre. */
  private static final String DIAG = "MARS/Glue/diag";

  private static final double DOS_PI = 2.0 * Math.PI;

  /** El orden TIENE que ser el del robot-map, y el de createDrivetrain(). */
  private static final String[] MODULOS = {"fl", "fr", "bl", "br"};

  /**
   * Ciclos sin latido nuevo antes de dar la simulación por ausente. A 250 Hz
   * son 0.4 s: bastante para no parpadear con un mensaje tardío, poco para que
   * abrir el Studio a mitad de sesión se note enseguida.
   */
  private static final int CICLOS_PARA_DARLA_POR_MUERTA = 100;

  private final SwerveDrivetrain<TalonFX, TalonFX, CANcoder> drivetrain;
  private final double reduccionDireccion;
  private final double acoplamiento;

  private double ultimoInstante = Utils.getCurrentTimeSeconds();
  private double ultimoLatido = -1.0;
  private int ciclosSinLatido = Integer.MAX_VALUE;
  private boolean conectado = false;
  private boolean reventado = false;
  private long ticks = 0;

  private final double[] mandos = new double[8];
  private final boolean[] hayObjetivo = new boolean[4];

  // --- lockstep -------------------------------------------------------------
  /**
   * Con MARS_LOCKSTEP=host:puerto el robot deja de correr en tiempo real: el
   * tiempo de WPILib se pausa y este glue lo avanza paso a paso, pidiéndole a
   * la física (mars-bridge --lockstep-port) exactamente un paso de 4 ms cada
   * vez. Cada corrida sale igual y una PC lenta va más lenta en vez de
   * degradar la física.
   *
   * <p>Lo que NO se puede pausar es el firmware simulado del TalonFX: Phoenix
   * corre en el reloj de pared (medido: tarda 1.5 ms de mediana y 2.2 ms como
   * mucho en reaccionar a un cambio de sensor). Por eso cada paso espera
   * MARS_LOCKSTEP_SETTLE_MS (2.5 por defecto) de pared antes de leer los
   * voltajes. Es lo que limita la velocidad a ~1-1.5x tiempo real.
   */
  private static final String LOCKSTEP = System.getenv("MARS_LOCKSTEP");
  private static final double PASO_S = 0.004;
  private static final int MAGIA = 0x4D4C5331; // "MLS1", ver bridge/src/lockstep.rs
  private volatile boolean lockstepActivo = false;
  private StructPublisher<Pose2d> verdad;

  public MarsSimGlue(SwerveDrivetrain<TalonFX, TalonFX, CANcoder> drivetrain) {
    this.drivetrain = drivetrain;

    // Se leen de TunerConstants en vez de escribirlas otra vez: si alguien
    // cambia la reducción allí, esto la sigue sin que nadie se acuerde.
    this.reduccionDireccion = TunerConstants.FrontLeft.SteerMotorGearRatio;
    this.acoplamiento = TunerConstants.FrontLeft.CouplingGearRatio;

    configurarSimState();

    // Dos señales de vida --- consola y NetworkTables --- porque no siempre se
    // está mirando la consola. Si `MARS/Glue/diag/creado` no aparece en el
    // árbol de NT, esta clase no llegó a construirse, y entonces el problema
    // está en el `if` que decide crearla y no aquí dentro.
    System.out.println("[MARS] glue creado, publicando en /" + SALIDA + "/");
    NetworkIO.set(DIAG, "creado", true);
    NetworkIO.set(DIAG, "reduccionDireccion", reduccionDireccion);
    NetworkIO.set(DIAG, "acoplamiento", acoplamiento);

    if (LOCKSTEP != null && !LOCKSTEP.isBlank()) {
      iniciarLockstep(LOCKSTEP.trim());
    }
  }

  /**
   * Orientación de cada motor y offset de cada CANcoder, como lo hace
   * SimSwerveDrivetrain de CTRE. Sin esto las posiciones que se escriben se leen
   * como CRUDAS: el CANcoder reporta crudo + offset del imán (el módulo FL salía
   * en -135.7° estando en 0°) y los motores invertidos ven su sentido al revés.
   *
   * <p>En tiempo real esto quedaba oculto por casualidad: el glue arrancaba con
   * la sim de CTRE mientras Gazebo no contestaba, y updateSimState() dejaba
   * estos campos puestos (getSimState() devuelve siempre la misma instancia).
   * En lockstep Gazebo contesta desde el primer paso y nunca pasaba.
   */
  private void configurarSimState() {
    var constantes =
        new com.ctre.phoenix6.swerve.SwerveModuleConstants<?, ?, ?>[] {
          TunerConstants.FrontLeft, TunerConstants.FrontRight,
          TunerConstants.BackLeft, TunerConstants.BackRight
        };
    for (int i = 0; i < 4; i++) {
      var c = constantes[i];
      var modulo = drivetrain.getModule(i);
      modulo.getDriveMotor().getSimState().Orientation =
          c.DriveMotorInverted ? ChassisReference.Clockwise_Positive : ChassisReference.CounterClockwise_Positive;
      modulo.getSteerMotor().getSimState().Orientation =
          c.SteerMotorInverted ? ChassisReference.Clockwise_Positive : ChassisReference.CounterClockwise_Positive;
      var encoder = modulo.getEncoder().getSimState();
      encoder.Orientation =
          c.EncoderInverted ? ChassisReference.Clockwise_Positive : ChassisReference.CounterClockwise_Positive;
      encoder.SensorOffset = c.EncoderOffset;
    }
  }

  /** Si la física de MARS está alimentando al robot ahora mismo. */
  public boolean conectado() {
    return conectado;
  }

  /**
   * Sustituye a {@code updateSimState}. Llamar desde el hilo de simulación del
   * drivetrain, a la misma tasa a la que se llamaba a aquel.
   */
  public void update() {
    // En lockstep el que mueve la física es el hilo de lockstep, no este
    // Notifier (que de todas formas solo dispara cuando ese hilo avanza el
    // tiempo de WPILib).
    if (lockstepActivo) {
      return;
    }
    // Un Notifier cuyo callback lanza se muere SIN DECIR NADA: el robot se
    // queda quieto y no hay ni una línea en la consola. Atrapar y avisar una
    // vez convierte ese fallo mudo en uno que se puede leer.
    try {
      actualizar();
    } catch (Throwable e) {
      if (!reventado) {
        reventado = true;
        System.err.println("[MARS] el glue fallo y se apaga: " + e);
        e.printStackTrace();
        NetworkIO.set(DIAG, "error", e.toString());
      }
    }
  }

  private void actualizar() {
    final double ahora = Utils.getCurrentTimeSeconds();
    final double dt = ahora - ultimoInstante;
    ultimoInstante = ahora;

    // Contador de vida del hilo. Si `MARS/Glue/diag/ticks` no sube en el árbol
    // de NT, este hilo no está corriendo --- que es un problema distinto de que
    // la simulación no conteste, y se arregla en otro sitio.
    NetworkIO.set(DIAG, "ticks", (double) (++ticks));

    final double bus = RobotController.getBatteryVoltage();
    NetworkIO.set(SALIDA, "enabled", DriverStation.isEnabled());

    // Publicar SIEMPRE, incluso desconectado: es lo que hace que arrancar MARS
    // Sim a mitad de sesión funcione sin reiniciar el robot.
    publicarMandos(bus);

    if (!hayDatos()) {
      // Sin simulación, la de CTRE. Trabajar sin abrir el Studio queda
      // exactamente como antes de instalar nada de esto.
      if (conectado) {
        conectado = false;
        System.out.println("[MARS] simulacion ausente; volviendo a la de CTRE");
        NetworkIO.set(DIAG, "conectado", false);
      }
      drivetrain.updateSimState(dt, bus);
      return;
    }

    if (!conectado) {
      conectado = true;
      System.out.println("[MARS] simulacion conectada; la fisica manda");
      NetworkIO.set(DIAG, "conectado", true);
    }
    inyectarFisica(bus);
  }

  /** Lo que el código del robot le está pidiendo a cada motor, publicado por NT4. */
  private void publicarMandos(double bus) {
    leerMandos(bus, mandos);
    for (int i = 0; i < 4; i++) {
      NetworkIO.set(SALIDA, MODULOS[i] + "_drive/duty", mandos[2 * i]);
      if (hayObjetivo[i]) {
        NetworkIO.set(SALIDA, MODULOS[i] + "_steer/setpoint", mandos[2 * i + 1]);
      }
    }
  }

  /**
   * Lee lo que el código del robot le pide a cada motor, en el orden del
   * robot-map: duty de tracción y consigna de dirección en rad del MOTOR. Un
   * módulo sin objetivo todavía conserva su consigna anterior.
   */
  private void leerMandos(double bus, double[] valores) {
    var estado = drivetrain.getState();

    for (int i = 0; i < 4; i++) {
      var modulo = drivetrain.getModule(i);
      var traccion = modulo.getDriveMotor().getSimState();
      var direccion = modulo.getSteerMotor().getSimState();

      // Phoenix necesita saber el voltaje de bus antes de poder decir qué está
      // aplicando. Sin esto getMotorVoltage() devuelve cero y el robot no se
      // mueve, sin ningún error en ninguna parte.
      traccion.setSupplyVoltage(bus);
      direccion.setSupplyVoltage(bus);

      valores[2 * i] = traccion.getMotorVoltage() / bus;

      // El ángulo objetivo del módulo, que es lo que tu swerve ya calculó --- y
      // ya optimizado, o sea que nunca pide girar más de 90 grados.
      hayObjetivo[i] = estado.ModuleTargets != null && estado.ModuleTargets.length > i;
      if (hayObjetivo[i]) {
        double vueltasModulo = estado.ModuleTargets[i].angle.getRotations();
        valores[2 * i + 1] = vueltasModulo * DOS_PI * reduccionDireccion;
      }
    }
  }

  /** Lo que la física devolvió por NT4 (modo tiempo real), metido en los sensores del robot. */
  private void inyectarFisica(double bus) {
    double[] pos = new double[8];
    double[] vel = new double[8];
    for (int i = 0; i < 4; i++) {
      pos[2 * i] = NetworkIO.get(ENTRADA, MODULOS[i] + "_drive/position", 0.0);
      vel[2 * i] = NetworkIO.get(ENTRADA, MODULOS[i] + "_drive/velocity", 0.0);
      pos[2 * i + 1] = NetworkIO.get(ENTRADA, MODULOS[i] + "_steer/position", 0.0);
      vel[2 * i + 1] = NetworkIO.get(ENTRADA, MODULOS[i] + "_steer/velocity", 0.0);
    }
    inyectar(pos, vel, NetworkIO.get(ENTRADA, "gyro/yaw", 0.0), bus);
  }

  /**
   * Mete en los sensores simulados de Phoenix el estado de la física. Lo usan
   * los dos modos: tiempo real (por NT4) y lockstep (por TCP).
   *
   * @param pos posición en rad del MOTOR, en el orden del robot-map: fl_drive,
   *     fl_steer, fr_drive, fr_steer, bl_drive, bl_steer, br_drive, br_steer
   * @param vel lo mismo en rad/s
   * @param yawGrados el yaw real del chasis, en grados
   */
  private void inyectar(double[] pos, double[] vel, double yawGrados, double bus) {
    for (int i = 0; i < 4; i++) {
      var modulo = drivetrain.getModule(i);
      var traccion = modulo.getDriveMotor().getSimState();
      var direccion = modulo.getSteerMotor().getSimState();
      var encoder = modulo.getEncoder().getSimState();
      encoder.setSupplyVoltage(bus);

      // El contrato entrega radianes y rad/s del eje del MOTOR; Phoenix quiere
      // vueltas y vueltas por segundo del ROTOR, que es el mismo eje.
      double vueltasDireccion = pos[2 * i + 1] / DOS_PI;
      double vueltasDireccionSeg = vel[2 * i + 1] / DOS_PI;
      double vueltasModulo = vueltasDireccion / reduccionDireccion;
      double vueltasModuloSeg = vueltasDireccionSeg / reduccionDireccion;

      direccion.setRawRotorPosition(Rotations.of(vueltasDireccion));
      direccion.setRotorVelocity(RotationsPerSecond.of(vueltasDireccionSeg));

      // El CANcoder mide el MÓDULO, no el rotor: hay que deshacer la reducción.
      // Y hay que alimentarlo aunque parezca redundante, porque la dirección
      // usa FusedCANcoder: si el CANcoder no se mueve, el control cree que el
      // módulo está clavado y satura.
      encoder.setRawPosition(Rotations.of(vueltasModulo));
      encoder.setVelocity(RotationsPerSecond.of(vueltasModuloSeg));

      // ACOPLAMIENTO. En un MK4, girar el azimut arrastra el motor de tracción:
      // kCoupleRatio vueltas de motor por vuelta de módulo. Gazebo no lo modela
      // --- sus dos joints son independientes --- así que se suma aquí, que es
      // donde se convierte a unidades de rotor.
      //
      // Sin esto el encoder de tracción no se movería al girar los módulos, y
      // la odometría del robot simulado sería MÁS limpia que la del real justo
      // en la maniobra donde peor se porta.
      double vueltasTraccion = pos[2 * i] / DOS_PI + vueltasModulo * acoplamiento;
      double vueltasTraccionSeg = vel[2 * i] / DOS_PI + vueltasModuloSeg * acoplamiento;

      traccion.setRawRotorPosition(Rotations.of(vueltasTraccion));
      traccion.setRotorVelocity(RotationsPerSecond.of(vueltasTraccionSeg));
    }

    // El giroscopio sale de la física, no de integrar las velocidades. Esa es
    // justamente la diferencia: si la odometría se equivoca, aquí se nota.
    drivetrain.getPigeon2().getSimState().setRawYaw(Degrees.of(yawGrados));
  }

  /**
   * Si la simulación está publicando de verdad.
   *
   * Se mira el LATIDO --- un contador que el bridge sube en cada ciclo --- y no
   * el valor de los sensores: un robot parado publica ceros que no se
   * distinguen de un canal muerto, y con eso el robot se quedaría congelado al
   * arrancar sin que nada lo explicara.
   */
  private boolean hayDatos() {
    double latido = NetworkIO.get(ENTRADA, "heartbeat", -1.0);
    if (latido != ultimoLatido) {
      ultimoLatido = latido;
      ciclosSinLatido = 0;
      return true;
    }
    if (ciclosSinLatido < CICLOS_PARA_DARLA_POR_MUERTA) {
      ciclosSinLatido++;
      return true;
    }
    return false;
  }

  // --- lockstep -------------------------------------------------------------

  private void iniciarLockstep(String destino) {
    String[] partes = destino.split(":");
    String host = partes[0];
    int puerto = partes.length > 1 ? Integer.parseInt(partes[1]) : 5811;
    double settleMs = 2.5;
    String settle = System.getenv("MARS_LOCKSTEP_SETTLE_MS");
    if (settle != null && !settle.isBlank()) {
      settleMs = Double.parseDouble(settle.trim());
    }

    Socket socket = null;
    long limite = System.nanoTime() + 15_000_000_000L;
    while (socket == null && System.nanoTime() < limite) {
      try {
        socket = new Socket(host, puerto);
      } catch (IOException e) {
        try {
          Thread.sleep(250);
        } catch (InterruptedException ie) {
          Thread.currentThread().interrupt();
          return;
        }
      }
    }
    if (socket == null) {
      System.err.println(
          "[MARS] lockstep: no hay bridge en " + destino + " (mars-bridge --lockstep-port "
              + puerto + "); sigo en tiempo real");
      NetworkIO.set(DIAG, "lockstep", false);
      return;
    }

    try {
      socket.setTcpNoDelay(true);
    } catch (IOException e) {
      // No es fatal: solo mas latencia por paso.
    }
    verdad =
        NetworkTableInstance.getDefault()
            .getStructTopic("/MARS/Sim/truthPose", Pose2d.struct)
            .publish();

    lockstepActivo = true;
    SimHooks.pauseTiming();
    System.out.println(
        "[MARS] lockstep conectado a " + destino + "; el tiempo de WPILib lo marca la fisica");
    NetworkIO.set(DIAG, "lockstep", true);

    final Socket conexion = socket;
    final long settleNs = (long) (settleMs * 1e6);
    Thread hilo = new Thread(() -> lazoLockstep(conexion, settleNs), "mars-lockstep");
    hilo.setDaemon(true);
    hilo.start();
  }

  private void lazoLockstep(Socket socket, long settleNs) {
    final int n = 8;
    ByteBuffer peticion =
        ByteBuffer.allocate(4 + 8 + 1 + 4 + 4 + 8 * n).order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer cabecera = ByteBuffer.allocate(4 + 8 + 8 * 4 + 4).order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer cuerpo = ByteBuffer.allocate(16 * n).order(ByteOrder.LITTLE_ENDIAN);
    double[] pos = new double[n];
    double[] vel = new double[n];
    long seq = 0;

    try (socket;
        DataOutputStream salida =
            new DataOutputStream(new BufferedOutputStream(socket.getOutputStream()));
        DataInputStream entrada =
            new DataInputStream(new BufferedInputStream(socket.getInputStream()))) {
      while (true) {
        double bus = RobotController.getBatteryVoltage();
        leerMandos(bus, mandos);

        seq++;
        peticion.clear();
        peticion.putInt(MAGIA).putLong(seq);
        peticion.put((byte) (DriverStation.isEnabled() ? 1 : 0));
        peticion.putInt(1).putInt(n);
        for (double v : mandos) {
          peticion.putDouble(v);
        }
        salida.write(peticion.array(), 0, peticion.position());
        salida.flush();

        entrada.readFully(cabecera.array());
        cabecera.rewind();
        if (cabecera.getInt() != MAGIA || cabecera.getLong() != seq) {
          throw new IOException("respuesta de lockstep fuera de orden");
        }
        cabecera.getDouble(); // tiempo de simulacion
        double x = cabecera.getDouble();
        double y = cabecera.getDouble();
        double yaw = cabecera.getDouble();
        int recibidos = cabecera.getInt();
        if (recibidos != n) {
          throw new IOException("el bridge mando " + recibidos + " actuadores, espero " + n);
        }
        entrada.readFully(cuerpo.array());
        cuerpo.rewind();
        for (int i = 0; i < n; i++) {
          pos[i] = cuerpo.getDouble();
          vel[i] = cuerpo.getDouble();
        }

        inyectar(pos, vel, Math.toDegrees(yaw), bus);
        verdad.set(new Pose2d(x, y, new Rotation2d(yaw)));

        // El robot corre su ciclo (cada 5 pasos) y los Notifiers que toquen.
        SimHooks.stepTiming(PASO_S);

        // El firmware del TalonFX no se pausa: darle tiempo de pared para que
        // reaccione a los sensores y a los mandos nuevos antes de leerlos.
        long hasta = System.nanoTime() + settleNs;
        while (System.nanoTime() < hasta) {
          Thread.onSpinWait();
        }

        NetworkIO.set(DIAG, "ticks", (double) (++ticks));
      }
    } catch (Throwable e) {
      // Sin lockstep el robot se quedaria con el tiempo congelado para siempre.
      // Mejor volver al tiempo real y decirlo.
      System.err.println("[MARS] lockstep terminado: " + e + "; vuelvo a tiempo real");
      NetworkIO.set(DIAG, "error", e.toString());
      lockstepActivo = false;
      SimHooks.resumeTiming();
    }
  }
}
