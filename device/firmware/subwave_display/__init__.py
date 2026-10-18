import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import http_request
from esphome.const import CONF_ID

CODEOWNERS = ["@subwave"]

# DEPENDENCIES, not AUTO_LOAD. This component needs http_request to EXIST before
# it is validated — it inherits HttpRequestComponent and resolves an id for it,
# which cannot be done by pulling it in afterwards. AUTO_LOAD would be silently
# ineffective here and the failure would surface much later, inside codegen.
DEPENDENCIES = ["http_request"]

subwave_display_ns = cg.esphome_ns.namespace("subwave_display")
SubwaveDisplay = subwave_display_ns.class_(
    "SubwaveDisplay", cg.PollingComponent, http_request.HttpRequestComponent
)

CONF_SERVER_URL = "server_url"
CONF_DEVICE_ID = "device_id"
CONF_CLAIM_TOKEN = "claim_token"
CONF_SETUP_AP_SSID = "setup_ap_ssid"
CONF_ARTWORK_SIZE = "artwork_size"
CONF_ART_BUFFER_BYTES = "art_buffer_bytes"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(SubwaveDisplay),
        # The client this component makes its requests through. Resolved from the
        # config rather than assumed, because there are two HttpRequestComponents
        # in this firmware: the top-level `http_request:` and this one. Omitting
        # it fails with "Too many candidates found for 'http_request_id'", which
        # is a strange way to say ESPHome will not guess between them.
        cv.GenerateID(http_request.CONF_HTTP_REQUEST_ID): cv.use_id(
            http_request.HttpRequestComponent
        ),
        # Identity is now OPTIONAL. A standard image carries none of it; the
        # device collects the server URL and a bind code during setup and stores
        # the resulting identity in flash. Per-device builds still work by
        # passing these substitutions, which is what the admin panel used to do.
        cv.Optional(CONF_SERVER_URL, default=""): cv.string,
        cv.Optional(CONF_DEVICE_ID, default=""): cv.string,
        cv.Optional(CONF_CLAIM_TOKEN, default=""): cv.string,
        cv.Optional(CONF_SETUP_AP_SSID, default="SUBWAVE-SCREEN"): cv.string,
        cv.Optional(CONF_ARTWORK_SIZE, default=640): cv.int_range(16, 2048),
        cv.Optional(CONF_ART_BUFFER_BYTES, default=65536): cv.int_range(8192, 1048576),
    }
).extend(cv.polling_component_schema("10s"))

# NO `timeout` OPTION AND NO `register_http_request()`.
#
# Both were how this was written against an older ESPHome. The component now
# inherits HttpRequestComponent directly and sets a timeout per request in C++
# (see display_client.cpp), because a 12s ceiling on a cover fetch and a 15s one
# on a claim are different problems with different costs — one blanket number
# would be wrong for at least one of them. The shared `http_request:` block sets
# the client-wide default.


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    # register_parented, NOT cg.add(var.set_client(...)). In 2026.7 the client is
    # a Parented relationship rather than a member this component assigns — and
    # `set_client` does not exist, so what you get instead is "Object shared_http
    # is an ID. Did you forget to register the variable?", which reads as a
    # missing declaration rather than a removed method.
    await cg.register_parented(var, config[http_request.CONF_HTTP_REQUEST_ID])

    # EVERY SETTER IS WRAPPED IN cg.add(), AND THAT IS NOT A STYLE POINT.
    #
    # `var.set_server_url(...)` on its own is an EXPRESSION whose value is
    # discarded. Nothing is written into main.cpp, so the call does not exist as
    # far as the firmware is concerned — and the build still succeeds, because
    # generating no code is not an error.
    #
    # This file shipped that way for the device's whole identity: server URL,
    # device id, claim token and setup AP SSID were all set by calls that were
    # never emitted. The screen therefore had an empty station URL, no device id
    # and no claim token, and could never have reached the station or claimed
    # itself. Everything that appeared to work — the panel, the WiFi scan, the
    # setup wizard — depends on none of those four, which is exactly why it went
    # unnoticed for so long.
    #
    # `check:firmware-setters` fails on an unwrapped setter in any external
    # component, so this cannot come back.
    if config.get(CONF_SERVER_URL):
        cg.add(var.set_server_url(config[CONF_SERVER_URL]))
    if config.get(CONF_DEVICE_ID):
        cg.add(var.set_device_id(config[CONF_DEVICE_ID]))
    if config.get(CONF_CLAIM_TOKEN):
        cg.add(var.set_claim_token(config[CONF_CLAIM_TOKEN]))
    cg.add(var.set_setup_ap_ssid(config[CONF_SETUP_AP_SSID]))

    await cg.register_component(var, config)
    cg.add(var.set_artwork_size(config[CONF_ARTWORK_SIZE]))
    cg.add(var.set_art_buffer_bytes(config[CONF_ART_BUFFER_BYTES]))
