# Conectar el código del robot a la simulación

Dos archivos:

- [`java/MarsSimGlue.java`](java/MarsSimGlue.java) — se copia al proyecto del robot.
- [`java/CommandSwerveDrivetrain.patch.md`](java/CommandSwerveDrivetrain.patch.md) — las dos líneas que cambian.

---

## Lo que hay que entender primero

Tu swerve **ya está simulado**. `CommandSwerveDrivetrain` arranca un `Notifier`
a 250 Hz que llama a `updateSimState(...)`, y eso es la simulación de CTRE:
modela los motores, aplica tus ganancias e integra la pose con la cinemática del
swerve.

Es una simulación **cinemática**. El robot va exactamente a donde las ecuaciones
dicen que iría. No tiene masa que acelerar, las ruedas no patinan, y atraviesa
las paredes — no porque esté mal hecha, sino porque no es su trabajo.

**MARS no añade una segunda simulación: reemplaza esa.** Se cambia una llamada y
los valores de los encoders pasan a salir de un robot con masa apoyado en un
suelo con fricción. Todo lo demás de tu código sigue igual: `TunerConstants`,
`SwerveRequestFactory`, `DriverBindings`, las ganancias de `Slot0Configs`. No
hay ninguna lógica de swerve duplicada en ningún sitio.

```
      ANTES                              DESPUÉS
 ┌──────────────────┐              ┌──────────────────┐
 │ tu código swerve │              │ tu código swerve │   ← igual
 └────────┬─────────┘              └────────┬─────────┘
          │                                 │
   updateSimState()                   MarsSimGlue
   cinemática de CTRE                       │
          │                                 ▼
          ▼                          física de Gazebo
   pose calculada                    masa, fricción, choques
```

---

## El workflow

Hay **cuatro procesos**, y solo uno es "el servidor".

### El servidor NT4 lo levanta tu código del robot

No nosotros. Eso no es cosa de la simulación: es cómo funciona un robot de
verdad. El roboRIO corre el servidor de NetworkTables y todo lo demás — el
dashboard, Shuffleboard, AdvantageScope — se conecta como cliente.

En simulación pasa igual: `./gradlew simulateJava` levanta el servidor en
`localhost:5810`. **Tu código del robot es el dueño de los datos**; MARS Simulation Studio,
el bridge y mars-desktop son clientes suyos.

|  | ¿servidor NT4? |
|---|---|
| Tu código del robot | **Sí** |
| mars-desktop | no, cliente |
| El bridge | no, cliente |
| MARS Simulation Studio | no habla NT4 |

Por eso el bridge **espera** en vez de morir cuando el servidor no está: vos
recompilás veinte veces por tarde y la física no tiene por qué reiniciarse con
cada compilación.

### Los cuatro procesos

| | qué hace |
|---|---|
| **mars-sim-server** | Gazebo sin ventana. La física, a 250 Hz. No sabe nada de WPILib. |
| **mars-sim-gui** | La ventana del mundo. Se *conecta* al servidor; se puede cerrar y reabrir sin tocar la física. |
| **mars-bridge** | El traductor. El único que habla los dos idiomas. |
| **MARS Simulation Studio** | Lanza los tres con el entorno correcto y los mata al cerrar. |

Los lanza todos el botón *Arrancar*.

### El orden de arranque no importa

1. **Simulation Studio** desde el Sidebar de mars-desktop → *Start simulation*. Aparece tu mundo.
2. **Tu robot**: `./gradlew simulateJava`.
3. **mars-desktop**: *Connect Sim*.

Si abrís la simulación primero, el bridge espera. Si reiniciás el robot a mitad
de partido, se vuelve a enganchar solo.

---

## Los dos flujos de datos

**Telemetría — funciona sin tocar tu código.** La pose real, el tiempo de
simulación, el real-time factor. Se publica en `/MARS/Sim/truthPose` y en
`/SmartDashboard/Field/Robot`.

Ojo con el nombre: `truthPose` es la pose **real** según la física. Nunca la
metas en tu odometría. Compará tu odometría contra ella — para eso está.

**Hardware — este necesita el glue.** Sin él, el motor de la simulación
mantiene par cero, igual que un robot real con el Driver Station apagado.

---

## Los dos modos de motor

| | quién cierra el lazo | qué publica el glue |
|---|---|---|
| tracción | nadie, lazo abierto | el voltaje aplicado / 12 |
| dirección | **el motor de la simulación** | el ángulo objetivo del módulo |

Una dirección 26:1 con Kraken tiene demasiado par para el tiempo que tarda un
mensaje en ir y volver: cerrar ese lazo por la red no funciona, y lo comprobamos
a 50 Hz y a 250 Hz. Un TalonFX real tampoco lo hace así — cierra posición
**dentro** del controlador, a 1 kHz. La simulación hace lo mismo.

---

## Que los números coincidan

`MarsSimGlue` lee las reducciones de `TunerConstants`, así que ese lado se
mantiene solo. Pero el mundo tiene los suyos, en
[`sim/worlds/gen_swerve.py`](../worlds/gen_swerve.py), y esos hay que
mantenerlos a mano:

| gen_swerve.py | TunerConstants.java |
|---|---|
| `RED_TRACCION` | `kDriveGearRatio` |
| `RED_DIRECCION` | `kSteerGearRatio` |
| `R_RUEDA` | `kWheelRadius` |
| `POS` | `kFrontLeftXPos` / `YPos` |

Están puestos con los valores de tu robot. Si cambian allí, cambiálos aquí y
volvé a correr `python sim/worlds/gen_swerve.py`. Una simulación con otra
reducción da velocidades que no son las tuyas, y afinar contra eso no sirve de
nada.

Los **nombres** de módulo (`fl`, `fr`, `bl`, `br`) tienen que coincidir con los
del `robot-map.json`. Un nombre mal escrito no da error en ninguna parte: el
motor no recibe nada y se queda quieto. Es el fallo más silencioso del sistema,
así que si un módulo no se mueve, mirá el árbol de NetworkTables bajo
`/MARS/Glue/`.

---

## Lockstep

En tiempo real, el robot y la física corren cada uno con su reloj. Funciona,
pero cada corrida sale distinta (±10% medido con el autotune de trayectoria de
Offseason2026) y una PC cargada degrada la física en vez de ir más lenta.

En **lockstep** el código del robot marca el paso: el tiempo de WPILib se pausa,
y cada paso de 4 ms el glue manda los comandos, la física avanza exactamente ese
paso y el robot no sigue hasta tener el estado resultante. La misma corrida da
el mismo resultado (±0.6% medido).

```powershell
# 1. el mundo (con real_time_factor 0) y el bridge en modo lockstep
.\simulationstudio\lockstep.ps1 -World worlds\offseason2026_lockstep.sdf `
    -RobotMap models\offseason2026\robot-map.json -Gui

# 2. el robot, en su proyecto
$env:MARS_LOCKSTEP = "127.0.0.1:5811"; ./gradlew simulateJava
```

Cómo funciona, de punta a punta:

| | qué hace |
|---|---|
| glue (Java) | pausa el tiempo de WPILib; por paso: lee los voltajes, manda los comandos por TCP, inyecta el estado, `SimHooks.stepTiming(0.004)` |
| bridge | `--lockstep-port`: recibe por TCP, publica el comando con `header.data["seq"]`, espera los joints con ese mismo seq |
| MarsLink | con comandos que traen `seq`, cada paso espera en `PreUpdate` al siguiente; publica joints y pose estampados con él |

**Por qué TCP y no NT4:** NT4 entrega como mucho cada 5 ms, o sea ≥10 ms por ida
y vuelta para un paso de 4 ms. Un socket local tarda microsegundos.

**El límite de velocidad es Phoenix, no Gazebo.** El firmware simulado del
TalonFX corre en el reloj de pared y no se puede pausar (medido: tarda 1.5 ms
de mediana y 2.2 ms como mucho en reaccionar a un cambio de sensor). Cada paso
espera `MARS_LOCKSTEP_SETTLE_MS` de pared antes de leer los voltajes:

| `MARS_LOCKSTEP_SETTLE_MS` | velocidad | efecto |
|---|---|---|
| 2.5 (defecto) | ~1.1x | fiel: el TalonFX siempre alcanzó a reaccionar |
| 1.0 | ~2x | ~10% de sesgo: a veces lee el voltaje de un paso atrás |
| 0.3 | ~3.4x | ~30%: demasiado retraso artificial para tunear |

Gazebo solo, con este robot, da ~3x tiempo real; sin el firmware de Phoenix de
por medio el lockstep podría acercarse a eso.

## Orientación y offsets de los sensores

El glue configura en el constructor `Orientation` de cada TalonFX y CANcoder y
el `SensorOffset` del CANcoder, igual que `SimSwerveDrivetrain` de CTRE. Sin eso
el CANcoder reporta la posición cruda más el offset del imán: un módulo en 0°
aparecía en -135.7°. En tiempo real el bug quedaba oculto por casualidad, porque
el glue arranca con la sim de CTRE mientras Gazebo no contesta y esa sim deja
los campos puestos. En lockstep Gazebo contesta desde el primer paso.
