(function(){
  const API_BASE = "https://welverdiend-booking-478269051372.europe-west1.run.app";
  let history = [];
  let isOpen = false;

  const style = document.createElement("style");
  style.textContent = `
    .wa-chat-btn{
      position:fixed;bottom:96px;right:22px;z-index:498;
      width:58px;height:58px;border-radius:50%;background:#4A4436;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;border:none;
      color:#fff;font-size:26px;transition:transform .15s ease;
    }
    .wa-chat-btn:hover{transform:scale(1.07);}
    .wa-chat-panel{
      position:fixed;bottom:162px;right:22px;z-index:498;
      width:340px;max-width:90vw;height:460px;max-height:70vh;
      background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);
      display:none;flex-direction:column;overflow:hidden;font-family:'Inter',sans-serif;
    }
    .wa-chat-panel.show{display:flex;}
    .wa-chat-header{
      background:#4A4436;color:#fff;padding:14px 16px;
      font-family:'Cormorant Garamond',serif;font-size:17px;
      display:flex;justify-content:space-between;align-items:center;flex-shrink:0;
    }
    .wa-chat-header button{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;}
    .wa-chat-messages{flex:1;overflow-y:auto;padding:14px;background:#FAF8F3;}
    .wa-chat-msg{margin-bottom:10px;font-size:13.5px;line-height:1.5;max-width:85%;padding:8px 12px;border-radius:10px;white-space:pre-wrap;}
    .wa-chat-msg.user{background:#4A4436;color:#fff;margin-left:auto;}
    .wa-chat-msg.bot{background:#fff;border:1px solid #E5E0D2;color:#2B2A26;}
    .wa-chat-input-row{display:flex;border-top:1px solid #E5E0D2;padding:10px;gap:8px;flex-shrink:0;}
    .wa-chat-input-row input{flex:1;border:1px solid #E5E0D2;border-radius:20px;padding:9px 14px;font-size:13px;font-family:inherit;}
    .wa-chat-input-row button{background:#4A4436;color:#fff;border:none;border-radius:20px;padding:9px 16px;font-size:13px;cursor:pointer;flex-shrink:0;}
    .wa-chat-input-row button:disabled{background:#B7AFA0;cursor:not-allowed;}
    @media (max-width:760px){
      .wa-chat-btn{bottom:82px;width:50px;height:50px;font-size:22px;}
      .wa-chat-panel{bottom:140px;right:12px;width:92vw;height:60vh;}
    }
  `;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.className = "wa-chat-btn";
  btn.innerHTML = "&#128172;";
  btn.setAttribute("aria-label", "Chat with us");
  document.body.appendChild(btn);

  const panel = document.createElement("div");
  panel.className = "wa-chat-panel";
  panel.innerHTML = `
    <div class="wa-chat-header">
      <span>Ask us anything</span>
      <button id="wa-chat-close" aria-label="Close">&times;</button>
    </div>
    <div class="wa-chat-messages" id="wa-chat-messages">
      <div class="wa-chat-msg bot">Hi! Ask me anything about Welverdiend Accommodation — the units, amenities, nearby places, or your stay.</div>
    </div>
    <div class="wa-chat-input-row">
      <input type="text" id="wa-chat-input" placeholder="Type a question...">
      <button id="wa-chat-send">Send</button>
    </div>
  `;
  document.body.appendChild(panel);

  function toggle(){
    isOpen = !isOpen;
    panel.classList.toggle("show", isOpen);
    if(isOpen) document.getElementById("wa-chat-input").focus();
  }
  btn.onclick = toggle;
  document.getElementById("wa-chat-close").onclick = toggle;

  function addMessage(text, role){
    const msgs = document.getElementById("wa-chat-messages");
    const div = document.createElement("div");
    div.className = `wa-chat-msg ${role}`;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }

  async function send(){
    const input = document.getElementById("wa-chat-input");
    const sendBtn = document.getElementById("wa-chat-send");
    const text = input.value.trim();
    if(!text) return;
    input.value = "";
    input.disabled = true;
    sendBtn.disabled = true;

    addMessage(text, "user");
    history.push({ role: "user", text });
    const thinking = addMessage("…", "bot");

    try{
      const res = await fetch(`${API_BASE}/api/chatbot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: history.slice(-10) })
      });
      const data = await res.json();
      thinking.remove();
      if(data.ok){
        addMessage(data.reply, "bot");
        history.push({ role: "bot", text: data.reply });
      } else {
        addMessage(data.error || "Sorry, something went wrong. Please try WhatsApp instead.", "bot");
      }
    }catch(err){
      thinking.remove();
      addMessage("Could not reach the chat right now — please try WhatsApp instead.", "bot");
    }

    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }
  document.getElementById("wa-chat-send").onclick = send;
  document.getElementById("wa-chat-input").addEventListener("keypress", (e) => { if(e.key === "Enter") send(); });
})();
