// Meta Pixel for welverdiendaccommodation.com.
// Every page: PageView. Unit pages: ViewContent. Any WhatsApp link tap: Contact.
// booking-widget.html and upload-proof.html call window.wdPixel() for InitiateCheckout, Lead and Purchase.
(function(){
  var PIXEL_ID = "1592972415909753";

  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,"script","https://connect.facebook.net/en_US/fbevents.js");

  fbq("init", PIXEL_ID);
  fbq("track", "PageView");

  var unit = location.pathname.match(/^\/(unit[12])(\.html)?$/);
  if(unit){
    fbq("track", "ViewContent", {
      content_ids: [unit[1]],
      content_type: "hotel",
      content_name: unit[1] === "unit1" ? "Unit 1" : "Unit 2"
    });
  }

  document.addEventListener("click", function(e){
    var link = e.target.closest && e.target.closest('a[href*="wa.me/"]');
    if(link) fbq("track", "Contact", { method: "whatsapp" });
  }, true);

  window.wdPixel = function(name, params){
    try{ fbq("track", name, params || {}); }catch(err){}
  };
})();
