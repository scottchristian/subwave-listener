import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.const import CONF_ID
from esphome.components import script
from esphome.components.wifi import request_wifi_scan_results_listener

CODEOWNERS = ["@subwave"]

# web_server_base is a DEPENDENCY, not AUTO_LOAD: this component reaches for
# `web_server_base::global_web_server_base` and that symbol only exists once the
# component has been instantiated. AUTO_LOAD would instantiate it, but ordering
# is decided by priority rather than by declaration order, so being explicit here
# documents the requirement instead of leaving it to chance.
#
# `script` is a dependency for the same class of reason: the on_scan_script
# option names a script id, and resolving that id needs script's registrations.
DEPENDENCIES = ["web_server_base", "wifi", "script"]

subwave_setup_web_ns = cg.esphome_ns.namespace("subwave_setup_web")
SetupWebComponent = subwave_setup_web_ns.class_("SetupWebComponent", cg.Component)

CONF_AP_SSID = "ap_ssid"
CONF_STATION_NAME = "station_name"
CONF_ON_SCAN_SCRIPT = "on_scan_script"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(SetupWebComponent),
        cv.Optional(CONF_AP_SSID): cv.string,
        cv.Optional(CONF_STATION_NAME): cv.string,
        # The script to run when a scan lands. A YAML script cannot implement
        # WiFiScanResultsListener — it is a C++ interface — so this id is the
        # seam between the two, and the component calls it at the right moment.
        #
        # `use_id`, NOT `declare_id`. The difference is the whole bug here:
        # `declare_id` REGISTERS a new id, so pointing it at a script that
        # already exists produces "ID wifi_scan_landed redefined! Check
        # script->17->id" — a validator error that reads as though scripts.yaml
        # had a duplicate, when in fact the schema is claiming ownership of an
        # id that is already spoken for. `use_id` resolves the existing one.
        cv.Optional(CONF_ON_SCAN_SCRIPT): cv.use_id(script.Script),
    }
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])

    # `add_scan_results_listener` DOES NOT EXIST until something asks for it.
    #
    # `WiFiComponent::add_scan_results_listener` is wrapped in
    # `#ifdef USE_WIFI_SCAN_RESULTS_LISTENERS`, and that define is generated from
    # a COUNT of components that called request_wifi_scan_results_listener() —
    # not from whether any component uses the interface. So without this call the
    # method is simply not compiled in, and calling it fails with:
    #
    #   'class esphome::wifi::WiFiComponent' has no member named
    #   'add_scan_results_listener'
    #
    # which points at wifi_component.h and at nothing wrong with this component.
    # The interface is opt-in by design — a device that never scans should not
    # pay for the listener vector.
    request_wifi_scan_results_listener()

    # `register_component` IS the registration. Without it the object is
    # allocated and never handed to `App`, so `setup()` is never called, the
    # handler is never added to `web_server_base`, and nothing anywhere
    # complains — the build succeeds, the firmware runs, and the wizard simply
    # does not exist. This is the whole bug: `new_Pvariable` allocates, it does
    # not register.
    await cg.register_component(var, config)

    if CONF_AP_SSID in config:
        cg.add(var.set_ap_ssid(config[CONF_AP_SSID]))
    if CONF_STATION_NAME in config:
        cg.add(var.set_station_name(config[CONF_STATION_NAME]))
    if CONF_ON_SCAN_SCRIPT in config:
        script_var = await cg.get_variable(config[CONF_ON_SCAN_SCRIPT])
        # `Script::execute()` returns void, so it cannot be handed straight to a
        # std::function<void()> — `set_on_scan_script(script->execute())` fails
        # with "invalid use of void expression". The lambda turns the call back
        # into an expression.
        #
        # cg.RawExpression, not cg.RawStatement: `cg.add` demands an Expression,
        # and RawStatement is a Statement. There is no cg.Lambda in ESPHome
        # 2026.7 — the codegen module has none — so the lambda is spelled out.
        cg.add(
            var.set_on_scan_script(
                cg.RawExpression(f"[](void) {{ {script_var}->execute(); }}")
            )
        )

