#!/usr/bin/env python3
"""Genera offseason2026.sdf y su robot-map: el swerve de STZ Offseason2026.

    python sim/worlds/gen_offseason2026.py

Reusa gen_swerve.py entero (la geometria de los modulos, el MarsLink, las
hitboxes de la cancha) y solo cambia los numeros que son de ESTE robot. No toca
swerve.sdf ni models/swerve/: el mundo generico sigue como estaba.

Cada numero de abajo dice de donde sale. Si cambia alla, se cambia aqui y se
vuelve a correr el script --- una simulacion con otra masa u otro limite de
corriente da un robot que no es el tuyo, y afinar contra eso no sirve.

  Offseason2026-main/src/main/java/frc/robot/configuration/constants/TunerConstants.java
  Offseason2026-main/src/main/deploy/pathplanner/settings.json
"""
import io
import json
import re

import gen_swerve as g

# --- de TunerConstants.java -------------------------------------------------
IN = 0.0254
g.POS = 10.875 * IN                     # kFrontLeftXPos/YPos = 10.875 in
g.ESQUINAS = [("fl", g.POS, g.POS), ("fr", g.POS, -g.POS),
              ("bl", -g.POS, g.POS), ("br", -g.POS, -g.POS)]
g.R_RUEDA = 2.0 * IN                    # kWheelRadius = 2 in (MK5n, rueda de 4")
g.RED_TRACCION = 5.2734375              # kDriveGearRatio
g.RED_DIRECCION = 26.09090909090909     # kSteerGearRatio
# kCoupleRatio (3.375) no va aqui: lo suma MarsSimGlue leyendolo de TunerConstants.

# kSlipCurrent = 120 A: CTRE lo aplica como limite de ESTATOR del motor de
# traccion, asi que es el limite que el TalonFX de verdad tiene puesto. Se copia
# tal cual en vez de calcular la corriente de deslizamiento como hace
# gen_swerve.py: si el robot real arranca patinando con 120 A, la simulacion
# tiene que patinar igual, no esconderlo.
g.LIMITE_TRACCION = 120
# steerInitialConfigs: StatorCurrentLimit = 60 A.
g.LIMITE_DIRECCION = 60

# Los TalonFX de traccion del swerve de CTRE quedan en Brake.
g.NEUTRO_TRACCION = "brake"

# --- masa e inercia (settings.json de PathPlanner) ---------------------------
# 58 kg con bateria y bumpers: el CAD da 43.3 kg sin bumper ni bateria ni
# piezas sin modelar; el equipo estima 54-62.
MASA_TOTAL = 58.0
# Lzz del CAD (8693 in^2*kg = 5.61 kg*m^2 para 43.3 kg) + bumpers (~0.66) +
# bateria (~0.1) + resto (~0.3) = ~6.7; escalado proporcional da 7.5. Se usa 7.0.
MOI_TOTAL = 7.0

g.M_RUEDA = 0.8
g.M_STEER = 1.2
g.M_CHASIS = MASA_TOTAL - 4 * (g.M_RUEDA + g.M_STEER)

# --- medidas del chasis ------------------------------------------------------
# Frame de 27 in: el centro de rueda de un SDS queda a 2.625 in del borde del
# frame, y 10.875 + 2.625 = 13.5 in de medio lado. Mas bumpers de 3.25 in por
# lado = 33.5 in = 0.851 m. La caja de colision es la de los BUMPERS, que es lo
# que toca las paredes.
FRAME = 2 * (10.875 + 2.625) * IN
BUMPER = 3.25 * IN
LADO = FRAME + 2 * BUMPER
g.CHASIS = (round(LADO, 4), round(LADO, 4), 0.15)

# --- mundo -------------------------------------------------------------------
# Sin FUEL con fisica y sin la malla de la cancha: lo que importa aqui es el
# real-time factor (el codigo del robot corre en tiempo de pared; si la fisica
# va a 0.5x, el seguimiento de trayectoria se ve peor de lo que es). Las
# hitboxes de la cancha se quedan: paredes y HUB siguen existiendo.
g.FUEL = 0
g.CAMPO_VISUAL = "ninguno"
g.HITBOXES = True

# Spawn corrido 1.25 m hacia el HUB azul: el tuner de trayectoria
# (PathFollowingTuner) avanza 2.5 m al frente y regresa. Desde (0,0) el bumper
# chocaria con el HUB rojo (x = 2.73..4.26); desde -1.25 el tramo va de -1.68 a
# +1.68 con bumpers incluidos, libre entre los dos HUB (+-2.73).
g.ROBOT_POSE = (-1.25, 0.0, 0.0, 0.0, 0.0, 0.0)

# La inercia del chasis no sale de "caja de 50 kg": se ajusta para que la del
# robot entero sobre Z sea MOI_TOTAL. Los modulos aportan m*r^2 por estar en las
# esquinas (mas su propia inercia, despreciable al lado).
_inercia_caja_original = g.inercia_caja


def _inercia_chasis(m, x, y, z):
    ix, iy, iz = _inercia_caja_original(m, x, y, z)
    if m != g.M_CHASIS:
        return ix, iy, iz
    r2 = 2 * g.POS ** 2
    modulos = 4 * (g.M_RUEDA + g.M_STEER) * r2
    iz = MOI_TOTAL - modulos
    # Un tensor valido necesita iz <= ix + iy.
    return max(ix, iz / 2 * 1.02), max(iy, iz / 2 * 1.02), iz


g.inercia_caja = _inercia_chasis


# El mu del suelo tal como lo escribe gen_swerve.py. El de la rueda es 1.1 y
# manda el menor de los dos, asi que variar el del suelo varia el agarre.
MU_SUELO = "<mu>0.9</mu><mu2>0.9</mu2>"


def aplicar_masa(masa):
    """Cambia la masa total. La inercia escala con ella: misma distribucion."""
    global MASA_TOTAL, MOI_TOTAL
    MOI_TOTAL = MOI_TOTAL * masa / MASA_TOTAL
    MASA_TOTAL = masa
    g.M_CHASIS = MASA_TOTAL - 4 * (g.M_RUEDA + g.M_STEER)


def a_lockstep(texto):
    """La misma fisica sin tope de tiempo real.

    En lockstep quien marca el paso es el codigo del robot (bridge con
    --lockstep-port, MarsLink esperando cada comando); con real_time_factor 1
    gz-sim dormiria entre pasos y el lockstep nunca pasaria de tiempo real. Se
    abre con `run`: sin robot conectado corre libre, a ~3x.
    """
    rtf = "<real_time_factor>1.0</real_time_factor>"
    assert rtf in texto, "gen_swerve cambio el bloque <physics>"
    return texto.replace(rtf, "<real_time_factor>0</real_time_factor>")


# --- el robot de verdad: mallas del CAD y mecanismos ---------------------------
# Si existe models/offseason2026/mecanismo.json (lo escribe
# Offseason2026-main/simustudio/gazebo/convertir_mecanismo.py a partir del
# Mechanism3D de MARS Desktop), el chasis deja de ser una caja naranja: lleva las
# mallas del CAD, el bumper y la torre como colision, y encima los mecanismos
# --- intake, dumper, shooter, caja, rodillos --- como links con su joint y su
# actuador. La fisica del swerve NO cambia: mismas ruedas, mismas reducciones.
#
# Sin el archivo el mundo sale como antes.
MECANISMO = g.SIM / "models" / "offseason2026" / "mecanismo.json"
# FUEL con fisica en offseason2026_cancha.sdf. Cada una es un cuerpo dinamico;
# ver FUEL en gen_swerve.py antes de subirlo.
FUEL_CANCHA = 12
# El CARGADOR VIRTUAL (Offseason2026-main/simustudio/gazebo/cargador_virtual.py)
# necesita dos cosas del mundo con cancha:
#   - ApplyLinkWrench, para darle a una FUEL su velocidad de salida con un
#     impulso de un paso de fisica;
#   - las FUEL que el robot trae PRECARGADAS: cuerpos de verdad, estacionados
#     lejos de la cancha, que el cargador teletransporta a la salida del
#     shooter. Las que recoge el intake van a parar al mismo estacionamiento.
# El estacionamiento es una rejilla en el piso, fuera de la cancha (que mide
# 16.5 x 8.2 m alrededor del origen): el piso es un plano infinito.
CARGADOR_PRECARGA = 8
ESTACIONAMIENTO = (30.0, 30.0)      # esquina de la rejilla, en m
ESTACIONAMIENTO_PASO = 0.4          # separacion entre pelotas, en m
ESTACIONAMIENTO_COLUMNAS = 10


def estacionamiento(i):
    """Donde se guarda la pelota numero i. cargador_virtual.py usa la misma rejilla."""
    x0, y0 = ESTACIONAMIENTO
    return (x0 + ESTACIONAMIENTO_PASO * (i % ESTACIONAMIENTO_COLUMNAS),
            y0 + ESTACIONAMIENTO_PASO * (i // ESTACIONAMIENTO_COLUMNAS))


def con_cargador(texto):
    """Agrega ApplyLinkWrench y las FUEL precargadas al mundo."""
    escena = '<plugin filename="gz-sim-scene-broadcaster-system" name="gz::sim::systems::SceneBroadcaster"/>'
    assert escena in texto, "gen_swerve cambio los plugins del mundo"
    texto = texto.replace(escena, escena + '\n    <plugin filename="gz-sim-apply-link-wrench-system"'
                          ' name="gz::sim::systems::ApplyLinkWrench"/>', 1)
    L = ["    <!-- FUEL precargadas del robot, estacionadas fuera de la cancha. Las",
         "         mueve el cargador virtual (simustudio/gazebo/cargador_virtual.py). -->"]
    for i in range(CARGADOR_PRECARGA):
        x, y = estacionamiento(i)
        L += ["    <include>",
              "      <uri>model://fuel</uri>",
              f"      <name>cargador_{i + 1:02d}</name>",
              f"      <pose>{x:.2f} {y:.2f} {g.RADIO_FUEL:.4f} 0 0 0</pose>",
              "    </include>"]
    robot = '    <model name="robot">'
    assert robot in texto
    return texto.replace(robot, "\n".join(L) + "\n\n" + robot, 1)


# Friccion seca de los rodillos y flywheels, en N*m sobre el joint. El Kraken
# entrega 7 N*m de calado: 0.03 es menos del 1% de eso.
FRICCION_RODILLO = 0.03
MODELO_URI = "model://offseason2026"


def cargar_mecanismo():
    if not MECANISMO.is_file():
        return None
    return json.loads(MECANISMO.read_text(encoding="utf-8"))


def ajustar_masas(mec):
    """Los mecanismos pesan: lo suyo se le quita al chasis y el robot sigue en MASA_TOTAL.

    Una prismatica tambien lleva la masa REFLEJADA de su motor (J_rotor * n^2,
    que en un eje lineal son kg): sin ella el PD del motor empuja una caja de 2
    kg con 800 N y el solver diverge, igual que pasaba con la direccion antes de
    que gen_swerve sumara la inercia reflejada.
    """
    total = 0.0
    for p in mec["piezas"]:
        p["masa_link"] = p["masa"]
        if p["tipo"] == "prismatic":
            p["masa_link"] += g.J_ROTOR * p["reduccion"] ** 2
        total += p["masa_link"]
    g.M_CHASIS -= total
    if g.M_CHASIS < 20:
        raise SystemExit(f"los mecanismos pesan {total:.1f} kg y dejan al chasis en {g.M_CHASIS:.1f}")
    # La colision del chasis es el bumper del CAD, no la estimacion de 33.5 in.
    g.CHASIS = tuple(round(v, 4) for v in mec["bumper"]["tamano"])


def _inercia_pieza(p):
    """Tensor del link con la inercia reflejada del motor sobre el eje del joint."""
    i = list(p["inercia"])
    if p["tipo"] != "revolute":
        return i
    eje = [abs(c) for c in p["eje"]]
    k = eje.index(max(eje))
    if max(eje) < 0.999:
        raise SystemExit(f"{p['nombre']}: eje {p['eje']} no alineado con X, Y o Z")
    i[k] += g.J_ROTOR * p["reduccion"] ** 2
    # Desigualdad triangular, igual que con_reflejada() en gen_swerve.
    minimo = i[k] / 2 * 1.02
    return [v if a == k else max(v, minimo) for a, v in enumerate(i)]


def _material(color):
    r, gr, b = color
    return (f"<material><ambient>{r * 0.45:.3f} {gr * 0.45:.3f} {b * 0.45:.3f} 1</ambient>"
            f"<diffuse>{r:.3f} {gr:.3f} {b:.3f} 1</diffuse>"
            f"<specular>0.15 0.15 0.15 1</specular></material>")


def con_mecanismo(texto, mec):
    """Mete las mallas y los mecanismos en el SDF que genero gen_swerve."""
    z = g.Z_CHASIS
    cx, cy, cz = g.CHASIS

    # 1. El visual del chasis: la caja naranja pasa a ser el CAD.
    caja = re.compile(r'\s*<visual name="visual">\s*<geometry><box><size>'
                      + re.escape(f"{cx} {cy} {cz}") + r"</size></box></geometry>.*?</visual>", re.S)
    visuales = []
    for n, v in enumerate(mec["visuales_chasis"]):
        visuales.append(
            f'\n        <visual name="cad_{n}">'
            f"\n          <pose>0 0 {-z:.4f} 0 0 0</pose>"
            f"\n          <geometry><mesh><uri>{MODELO_URI}/{v['malla']}</uri></mesh></geometry>"
            f"\n          {_material(v['color'])}"
            f"\n        </visual>")
    texto, n = caja.subn(lambda _: "".join(visuales), texto, count=1)
    assert n == 1, "gen_swerve cambio el visual del chasis"

    # 2. La colision: bumper a su altura real, y la torre encima.
    vieja = f'<collision name="collision"><geometry><box><size>{cx} {cy} {cz}</size></box></geometry></collision>'
    assert vieja in texto, "gen_swerve cambio la colision del chasis"
    b, t = mec["bumper"], mec["colision_superior"]
    nueva = (
        f'<collision name="bumper"><pose>{b["centro"][0]} {b["centro"][1]} {b["centro"][2] - z:.4f} 0 0 0</pose>'
        f'<geometry><box><size>{cx} {cy} {cz}</size></box></geometry></collision>\n'
        f'        <collision name="torre"><pose>{t["centro"][0]} {t["centro"][1]} {t["centro"][2] - z:.4f} 0 0 0</pose>'
        f'<geometry><box><size>{" ".join(str(v) for v in t["tamano"])}</size></box></geometry></collision>')
    texto = texto.replace(vieja, nueva, 1)

    # 3. Los cilindros de los modulos sobran: las ruedas ya estan en la malla
    #    del CAD. Los links y su fisica se quedan; solo se van los dibujos.
    texto, n = re.subn(r'\n\s*<visual name="visual">\s*<geometry><cylinder>.*?</visual>', "", texto, flags=re.S)
    assert n == 8, f"esperaba 8 visuales de modulo, hay {n}"

    # 4. Los mecanismos, antes del plugin.
    L = []
    w = L.append
    w("")
    w("      <!-- MECANISMOS. Salen del Mechanism3D de MARS Desktop")
    w(f"           ({mec['fuente']}) via convertir_mecanismo.py: el pivote, el eje")
    w("           y los limites son los de alla. Solo visual y masa: no chocan")
    w("           con nada, para que un brazo no empuje al propio robot. -->")
    for p in mec["piezas"]:
        nombre = p["nombre"]
        px, py, pz = p["pivote"]
        ix, iy, iz = _inercia_pieza(p)
        mx, my, mz = p["centro_masa"]
        w("")
        w(f"      <!-- {p['pieza']} -> {nombre} ({p['control']}) -->")
        w(f'      <link name="{nombre}">')
        w(f"        <pose>{px} {py} {pz} 0 0 0</pose>")
        w("        <inertial>")
        w(f"          <pose>{mx} {my} {mz} 0 0 0</pose>")
        w(f"          <mass>{p['masa_link']:.4f}</mass>")
        w(f"          <inertia><ixx>{ix:.6f}</ixx><iyy>{iy:.6f}</iyy><izz>{iz:.6f}</izz>")
        w("            <ixy>0</ixy><ixz>0</ixz><iyz>0</iyz></inertia>")
        w("        </inertial>")
        w('        <visual name="cad">')
        w(f"          <pose>{-px} {-py} {-pz} 0 0 0</pose>")
        w(f"          <geometry><mesh><uri>{MODELO_URI}/{p['malla']}</uri></mesh></geometry>")
        w(f"          {_material(p['color'])}")
        w("        </visual>")
        w("      </link>")
        w(f'      <joint name="{nombre}_joint" type="{p["tipo"]}">')
        w(f"        <parent>chassis</parent><child>{nombre}</child>")
        w(f"        <axis><xyz>{' '.join(str(c) for c in p['eje'])}</xyz>")
        # Un rodillo es liviano y gira a cientos de rad/s: 0.01 N*m*s/rad ahi
        # son 5 N*m de freno a 500 rad/s, mas que el par que el Kraken entrega
        # con su limite de corriente, y el shooter no pasaba de la mitad de su
        # velocidad libre. Medido: 0.0005 deja llegar a ~95%.
        #
        # Pero sin NADA mas, un rodillo en coast no se detiene nunca: cualquier
        # sacudida del chasis lo pone a girar y 0.0005 apenas lo frena (medido:
        # el indexer oscilando a +-10 rad/s con duty 0, sin parar). Lo que lo
        # para en el robot real es la friccion SECA de rodamientos y bandas,
        # que no crece con la velocidad: frena del todo una pieza lenta y casi
        # no le quita nada al shooter a 500 rad/s.
        amort = 0.01 if p["control"] == "position" else 0.0005
        seca = "" if p["control"] == "position" else f"<friction>{FRICCION_RODILLO}</friction>"
        w(f"          <dynamics><damping>{amort}</damping>{seca}</dynamics>")
        lo, hi = p["limites"] if p["limites"] else (-1e16, 1e16)
        w(f"          <limit><lower>{lo}</lower><upper>{hi}</upper></limit></axis>")
        w("      </joint>")
    w("")
    marca = "\n      <!-- El ORDEN es el contrato"
    assert marca in texto, "gen_swerve cambio el comentario del plugin"
    texto = texto.replace(marca, "\n".join(L) + marca, 1)

    # 5. Sus actuadores, al final del plugin: el orden es el del robot-map.
    acts = []
    for p in mec["piezas"]:
        a = (f'        <actuator joint="{p["nombre"]}_joint" motor="{p["motor"]}"'
             f' gearRatio="{p["reduccion"]}" currentLimit="{p["limite_corriente"]}"')
        if p["control"] == "position":
            a += f' control="position" kp="{p["kp"]}" kd="{p["kd"]}"'
        acts.append(a + "/>")
    fin = "      </plugin>"
    assert texto.count(fin) == 1
    return texto.replace(fin, "\n".join(acts) + "\n" + fin, 1)


def mapa_con_mecanismo(mapa, mec):
    """Los actuadores de los mecanismos van DESPUES de los ocho del swerve, en el orden del SDF."""
    for p in mec["piezas"]:
        mapa["actuators"].append({
            "name": p["nombre"],
            "joint": f"{p['nombre']}_joint",
            "motor": p["motor"],
            "gearRatio": p["reduccion"],
            "inverted": False,
            "control": p["control"],
            "hal": {"kind": "pwm", "channel": len(mapa["actuators"])},
        })
        mapa["encoders"].append({
            "name": f"{p['nombre']}_enc",
            "joint": f"{p['nombre']}_joint",
            "countsPerRevolution": 42 if p["motor"].startswith("neo") else 2048,
            "hal": {"kind": "encoder", "index": len(mapa["encoders"])},
        })
    return mapa


def escribir(ruta, texto):
    io.open(ruta, "w", encoding="utf-8", newline="\n").write(texto)
    print(f"escrito {ruta.relative_to(g.SIM)}")


def main():
    import argparse

    cli = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    cli.add_argument("--masa", type=float, default=None,
                     help=f"masa total en kg (defecto {MASA_TOTAL}); la inercia escala igual")
    cli.add_argument("--mu", type=float, default=None,
                     help="coeficiente de friccion del suelo (defecto 0.9)")
    cli.add_argument("--sufijo", default=None,
                     help="escribe SOLO worlds/offseason2026_<sufijo>_lockstep.sdf, "
                          "una variante para el autotune robusto, sin tocar el mundo "
                          "nominal ni el robot-map")
    args = cli.parse_args()

    if args.masa is not None:
        aplicar_masa(args.masa)
    mec = cargar_mecanismo()
    if mec is not None:
        ajustar_masas(mec)
    texto = g.generar_sdf()
    if mec is not None:
        texto = con_mecanismo(texto, mec)
    if args.mu is not None:
        assert MU_SUELO in texto, "gen_swerve cambio el <friction> del suelo"
        texto = texto.replace(MU_SUELO, f"<mu>{args.mu}</mu><mu2>{args.mu}</mu2>")

    masa_mec = sum(p["masa_link"] for p in mec["piezas"]) if mec is not None else 0.0
    resumen = (f"masa {g.M_CHASIS + 4 * (g.M_RUEDA + g.M_STEER) + masa_mec:.1f} kg, "
               f"izz robot {MOI_TOTAL:.2f}, mu {args.mu if args.mu is not None else 0.9}")

    if args.sufijo:
        escribir(g.SIM / "worlds" / f"offseason2026_{args.sufijo}_lockstep.sdf", a_lockstep(texto))
        print(resumen)
        return

    escribir(g.SIM / "worlds" / "offseason2026.sdf", texto)
    escribir(g.SIM / "worlds" / "offseason2026_lockstep.sdf", a_lockstep(texto))

    # El mismo robot sobre la cancha 2026 dibujada y con FUEL delante: el mundo
    # para MANEJAR y ver los mecanismos. El nominal de arriba no lleva malla de
    # cancha a proposito (es el del autotune y ahi manda el real-time factor);
    # este si, en "lite", que es la que una laptop sostiene a RTF ~1.
    if (g.SIM / g.CAMPO).is_file():
        g.CAMPO_VISUAL, g.FUEL = "lite", FUEL_CANCHA
        cancha = g.generar_sdf()
        if mec is not None:
            cancha = con_mecanismo(cancha, mec)
        escribir(g.SIM / "worlds" / "offseason2026_cancha.sdf", con_cargador(cancha))
        g.CAMPO_VISUAL, g.FUEL = "ninguno", 0
    else:
        print(f"sin {g.CAMPO}: no se escribe offseason2026_cancha.sdf")

    mapa = g.generar_robot_map()
    if mec is not None:
        mapa = mapa_con_mecanismo(mapa, mec)
    mapa["$comment"] = ("GENERADO por sim/worlds/gen_offseason2026.py junto con "
                        "offseason2026.sdf. No editar a mano.")
    mapa["robot"] = "offseason2026"
    mapa["sdf"] = "worlds/offseason2026.sdf"
    ruta = g.SIM / "models" / "offseason2026" / "robot-map.json"
    ruta.parent.mkdir(parents=True, exist_ok=True)
    escribir(ruta, json.dumps(mapa, indent=2, ensure_ascii=False) + "\n")

    print(f"chasis {g.CHASIS[0]:.3f} x {g.CHASIS[1]:.3f} m, {resumen}, "
          f"izz chasis {_inercia_chasis(g.M_CHASIS, *g.CHASIS)[2]:.2f}, "
          f"traccion {g.LIMITE_TRACCION} A {g.NEUTRO_TRACCION}")


if __name__ == "__main__":
    main()
