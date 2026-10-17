#include "setup_portal.h"

#include "esphome/core/log.h"

namespace subwave_display {

static const char *const TAG = "subwave.setup";

/*
 * THE SETUP PAGE, AS ONE STRING.
 *
 * Served by the device from its own access point, which means there is no
 * internet behind it: no CDN, no webfont, no external image, no fetch of any
 * kind. Everything the page needs is inline, including its behaviour.
 *
 * WHY THE SYSTEM FONT STACK AND NOT A WEBFONT. Not a compromise — a device with
 * no network cannot load one, and a page that renders in Times because the font
 * request timed out looks broken in a way a plain page does not. All the
 * personality comes from weight and tracking instead: -0.02em on the headline,
 * 0.08em on the small labels.
 *
 * WHY THE PAPER. The product is glass — dark and cool, because a panel on a wall
 * is a lit object in a room. This is a document, and light makes it obvious that
 * you are configuring something rather than already using it.
 *
 * WHY 16PX INPUTS. Anything smaller and iOS zooms the whole page the moment the
 * field takes focus, and the user loses the button they were reaching for. This
 * is the single most common mobile-web annoyance and it is entirely avoidable.
 *
 * WHY THE ORDER OF THE INSTRUCTIONS IS JOIN FIRST, SCAN SECOND. A phone cannot
 * load a page from a network it is not on. Every other order fails on every
 * phone, and the failure looks like a broken device rather than a wrong step.
 */
// A POINTER, not an array of pointers. `const char *SETUP_PAGE[] = R"HTML(...)"`
// declares an unsized array, and initialising that from a string literal is
// rejected outright — after which `std::string(SETUP_PAGE)` fails too, because
// the array has decayed into something that is not a string.
//
// PROGMEM is an AVR qualifier and does nothing on a RISC-V ESP32-P4. It is gone
// rather than left in as decoration: a macro that means nothing here will start
// to mean something on the next port.
static const char *const SETUP_PAGE = R"HTML(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Set up your screen</title>
<style>
  :root{
    --paper:#F7F6F3; --ink:#16191C; --muted:#5A6570; --rule:#DDD8D0;
    --lamp:#C89A54; --field:#FFFFFF; --bad:#B4432F;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--paper);color:var(--ink);
    font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:30rem;margin:0 auto;padding:2rem 1.25rem 4rem}
  .who{display:flex;align-items:center;gap:.5rem;font-size:.8125rem;letter-spacing:.08em;
    text-transform:uppercase;color:var(--muted);margin-bottom:2.5rem}
  .dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--lamp);flex:none}
  h1{font-size:1.75rem;line-height:1.15;letter-spacing:-.02em;font-weight:700;margin:0 0 2rem}
  ol{list-style:none;padding:0;margin:0 0 2.5rem}
  li{display:grid;grid-template-columns:1.25rem 1fr;gap:.75rem;padding:.625rem 0;
    color:var(--muted);align-items:start}
  li .rail{width:2px;height:1.5rem;background:var(--rule);border-radius:1px;margin-top:.25rem}
  li.done{color:var(--ink)}
  li.done .rail{background:var(--lamp)}
  li.now{color:var(--ink)}
  li.now .rail{background:var(--lamp)}
  label{display:block;font-size:.8125rem;letter-spacing:.08em;text-transform:uppercase;
    color:var(--muted);margin:1.5rem 0 .5rem}
  input{width:100%;font-size:1rem;padding:.875rem 1rem;background:var(--field);
    border:1px solid var(--rule);border-radius:.5rem;color:var(--ink);font-family:inherit}
  input:focus{outline:2px solid var(--lamp);outline-offset:1px;border-color:transparent}
  .wrap-field{position:relative}
  .wrap-field input{padding-right:3.25rem}
  .peek{position:absolute;right:.5rem;top:50%;transform:translateY(-50%);
    background:none;border:0;padding:.5rem;cursor:pointer;color:var(--muted)}
  .net{display:flex;flex-direction:column;gap:.25rem;margin:.5rem 0 0}
  .net button{display:flex;align-items:center;gap:.75rem;width:100%;text-align:left;
    font-size:1rem;padding:.875rem 1rem;background:var(--field);border:1px solid var(--rule);
    border-radius:.5rem;color:var(--ink);cursor:pointer;font-family:inherit;min-height:3rem}
  .net button[aria-pressed=true]{border-color:var(--lamp);box-shadow:0 0 0 1px var(--lamp) inset}
  .manual{background:none;border:0;padding:1rem 0 0;color:var(--muted);
    text-decoration:underline;font-size:.9375rem;cursor:pointer;font-family:inherit}
  button.go{width:100%;margin-top:2rem;padding:1rem;font-size:1rem;font-weight:600;
    background:var(--ink);color:var(--paper);border:0;border-radius:.5rem;cursor:pointer;
    min-height:3rem;font-family:inherit}
  button.go[disabled]{opacity:.45;cursor:default}
  .why{font-size:.9375rem;color:var(--muted);line-height:1.5;margin:.5rem 0 0}
  .bad{color:var(--bad);font-size:.9375rem;line-height:1.5;margin:1.5rem 0 0;
    border-left:2px solid var(--bad);padding-left:.875rem}
  .bad[hidden]{display:none}
  hr{border:0;border-top:1px solid var(--rule);margin:2.5rem 0 2rem}
  fieldset{border:0;padding:0;margin:0}
</style>
</head>
<body>
<div class="wrap">
  <p class="who"><span class="dot"></span><span id="apname">SUBWAVE-SCREEN</span></p>
  <h1>Set up your screen</h1>

  <ol id="steps">
    <li id="s1" class="done"><span class="rail"></span><span>Join this network</span></li>
    <li id="s2"><span class="rail"></span><span>Pick your Wi-Fi</span></li>
    <li id="s3"><span class="rail"></span><span>Check the connection</span></li>
  </ol>

  <div id="pick">
    <label for="ssid">Nearby networks</label>
    <div class="net" id="nets"></div>
    <button class="manual" id="manualtoggle" type="button">Enter it manually</button>

    <div id="manual" hidden>
      <label for="ssid2">Network name</label>
      <input id="ssid2" autocomplete="off" autocapitalize="none" spellcheck="false">
    </div>

    <label for="pass">Password</label>
    <div class="wrap-field">
      <input id="pass" type="password" autocomplete="off" autocapitalize="none" spellcheck="false">
      <button class="peek" id="peek" type="button" aria-label="Show password">Show</button>
    </div>
    <button class="go" id="go" type="button">Connect</button>
  </div>

  <p class="bad" id="err" hidden></p>

  <div id="geo" hidden>
    <hr>
    <label>Where is this screen?</label>
    <p class="why">Used to work out when sunset is, so the screen dims on its own.</p>
    <button class="go" id="usemygeo" type="button">Use my location</button>
    <p class="why">Or type it: <input id="latlon" style="width:12rem;display:inline-block;margin-top:.5rem"
       inputmode="decimal" placeholder="-37.8140, 144.9633"></p>
    <label style="margin-top:1.5rem"><input type="checkbox" id="stationdefault" style="width:auto">
      Save as the station default</label>
  </div>
</div>
<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var chosen=null, geo=null;

  // Nearby networks come from the screen itself, so nobody types an SSID that is
  // three metres away but spelled differently.
  fetch('/networks').then(function(r){return r.json()}).then(function(d){
    if(!d.networks||!d.networks.length)return;
    var box=$('nets');
    d.networks.forEach(function(n){
      var b=document.createElement('button');b.type='button';
      b.setAttribute('aria-pressed', n.ssid===chosen?'true':'false');
      b.textContent=n.ssid+'  ·  '+n.rssi+' dBm';
      b.onclick=function(){chosen=n.ssid;$('ssid2').value=n.ssid;
        [].forEach.call(box.children,function(c){c.setAttribute('aria-pressed','false')});
        b.setAttribute('aria-pressed','true');};
      box.appendChild(b);
    });
  }).catch(function(){});

  $('manualtoggle').onclick=function(){$('manual').hidden=!$('manual').hidden};
  $('peek').onclick=function(){
    var p=$('pass');p.type=p.type==='password'?'text':'password';
    this.textContent=p.type==='password'?'Show':'Hide';};

  function fail(msg){$('err').textContent=msg;$('err').hidden=false}

  $('go').onclick=function(){
    var ssid=(chosen||$('ssid2').value||'').trim();
    if(!ssid)return fail('Choose a network, or type its name above.');
    var pass=$('pass').value;
    $('err').hidden=true;$('s2').className='done';
    $('go').disabled=true;
    fetch('/wifi',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ssid:sssid,password:pass})})
      .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
      .then(function(res){
        // THREE FAILURES, THREE FIXES. The most common one by far is a guest
        // network or captive portal: the screen joins, looks connected, and
        // cannot resolve anything. Saying so by name is the difference between
        // a person who fixes it and a person who gives up.
        if(res.ok){$('s3').className='now';$('geo').hidden=false;$('pick').hidden=true;
          document.querySelector('h1').textContent='Almost there';return}
        $('s2').className='now';$('go').disabled=false;
        if(res.j.reason==='bad-password')
          fail('That password did not work. Check it and try again.');
        else if(res.j.reason==='no-internet')
          fail('Your network is connected but cannot reach the internet. Guest networks need a sign-in page — open the page your network opened, sign in, then try again.');
        else
          fail('The screen could not join that network. Check the name and try again.');
      }).catch(function(){$('go').disabled=false;
        fail('Lost contact with the screen. Close this page and open it again.');});
  };

  $('usemygeo').onclick=function(){
    if(!navigator.geolocation)return fail('This browser cannot share a location. Type it in below instead.');
    $('usemygeo').disabled=true;
    navigator.geolocation.getCurrentPosition(function(p){
      geo=[p.coords.latitude.toFixed(4),p.coords.longitude.toFixed(4)].join(', ');
      $('latlon').value=geo;$('usemygeo').disabled=false;
      finish();
    },function(){$('usemygeo').disabled=false;
      fail('The location was not shared. Type it in below instead.');});
  };

  function finish(){
    var tz='';try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}
    var ll=($('latlon').value||geo||'').split(',');
    var body={timezone:tz};
    if(ll.length===2){body.lat=parseFloat(ll[0]);body.lon=parseFloat(ll[1]);}
    body.saveAsStationDefault=$('stationdefault').checked;
    fetch('/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json()})
      .then(function(){
        $('s3').className='done';
        document.querySelector('h1').textContent='That is it';
        var ol=document.querySelector('ol');if(ol)ol.remove();
        $('geo').hidden=true;$('pick').hidden=true;
        var p=document.createElement('p');p.className='why';
        p.textContent='The screen will start showing what is playing. You can close this page.';
        document.querySelector('.wrap').appendChild(p);
      }).catch(function(){fail('The screen did not accept that. Try again in a moment.')});
  }
  $('latlon').onchange=finish;
  $('stationdefault').onchange=finish;
})();
</script>
</body>
</html>
)HTML";

std::string SetupPortal::page_html() {
  return std::string(SETUP_PAGE);
}

void SetupPortal::setup() {
  ESP_LOGI(TAG, "Setup page ready on %s (join this network first, then open http://192.168.4.1).",
           this->ap_ssid_.c_str());
}

void SetupPortal::dump_config() {
  ESP_LOGCONFIG(TAG, "Setup Portal:");
  ESP_LOGCONFIG(TAG, "  AP SSID: %s", this->ap_ssid_.c_str());
  ESP_LOGCONFIG(TAG, "  Page: served from flash, no network needed");
}

}  // namespace subwave_display