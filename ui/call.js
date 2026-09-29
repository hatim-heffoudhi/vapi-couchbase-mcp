const PHONE_ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.77.62 2.61a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.47-1.19a2 2 0 0 1 2.11-.45c.84.29 1.71.5 2.61.62A2 2 0 0 1 22 16.92z"/></svg>';

const LIVE_ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

function ensureStyles() {
  if (document.getElementById("support-call-style")) return;
  const style = document.createElement("style");
  style.id = "support-call-style";
  style.textContent = `
    .cb-nav nav { row-gap: 10px; }
    .support-call {
      display: inline-flex; align-items: center; gap: 8px;
      font: inherit; cursor: pointer; margin-top: 0; margin-left: 8px;
      border-radius: 999px; padding: 8px 14px;
      border: 1px solid #cc2a2e; background: #cc2a2e; color: #fff;
    }
    .support-call.live {
      background: #2e7d32; border-color: #2e7d32;
      animation: call-pulse 1.4s ease-in-out infinite;
    }
    .support-call:disabled { opacity: 0.55; cursor: wait; }
    .support-call.fab {
      position: fixed; right: 22px; bottom: 22px; z-index: 40;
      min-width: 58px; height: 58px; padding: 0 16px; justify-content: center;
      box-shadow: 0 10px 24px rgba(27, 27, 24, 0.18);
    }
    .support-call.fab.live { width: auto; }
    .support-call.fab:not(.live) .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .support-call-hint { color: #cfcfcf; font-size: 0.8rem; margin: 0; }
    @keyframes call-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(46, 125, 50, 0.45); }
      50% { box-shadow: 0 0 0 8px rgba(46, 125, 50, 0); }
    }
  `;
  document.head.appendChild(style);
}

function syncButtons(buttons, state) {
  const live = state === "live" || state === "connecting";
  const text = state === "live" ? "Call in progress…" : state === "connecting" ? "Connecting…" : "Call support";
  for (const button of buttons) {
    button.classList.toggle("live", live);
    button.disabled = false;
    const icon = button.querySelector("svg");
    if (icon) icon.outerHTML = live ? LIVE_ICON : PHONE_ICON;
    const label = button.querySelector(".label");
    if (label) label.textContent = text;
    button.setAttribute("aria-label", text);
  }
}

async function boot() {
  ensureStyles();
  const res = await fetch("/api/support-call");
  const cfg = await res.json();
  const buttons = [...document.querySelectorAll("[data-support-call]")];
  if (!document.querySelector("[data-support-call].fab")) {
    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "support-call fab";
    fab.dataset.supportCall = "1";
    fab.innerHTML = `${PHONE_ICON}<span class="label">Call support</span>`;
    document.body.appendChild(fab);
    buttons.push(fab);
  }

  if (!cfg.ready) {
    for (const button of buttons) button.disabled = true;
    const hint = document.createElement("p");
    hint.className = "support-call-hint";
    hint.textContent = cfg.reason || "Support calling is not ready yet.";
    document.querySelector(".cb-nav .inner")?.appendChild(hint);
    return;
  }

  const WINDOW_NAME = "support-call";

  let popup = null;
  const channel = new BroadcastChannel("support-call");
  const current = localStorage.getItem("support-call-state") || "idle";
  syncButtons(buttons, current);

  channel.onmessage = (event) => {
    if (event.data?.type === "ping" || event.data?.type === "focus" || event.data?.type === "raise") return;
    const state = event.data?.state || "idle";
    syncButtons(buttons, state);
    if (state === "idle") popup = null;
  };

  if (current === "live" || current === "connecting") {
    let heard = false;
    const wait = (event) => {
      if (event.data?.state) heard = true;
    };
    channel.addEventListener("message", wait);
    channel.postMessage({ type: "ping" });
    setTimeout(() => {
      channel.removeEventListener("message", wait);
      if (!heard) {
        try { localStorage.setItem("support-call-state", "idle"); } catch {}
        syncButtons(buttons, "idle");
      }
    }, 400);
  }

  const showPopupHint = () => {
    if (document.querySelector(".support-call-hint")) return;
    const hint = document.createElement("p");
    hint.className = "support-call-hint";
    hint.textContent = "Allow the support-call popup so Jack keeps talking while you use Shop or Supervisor.";
    document.querySelector(".cb-nav .inner")?.appendChild(hint);
  };

  const raisePopup = () => {
    let existing = popup && !popup.closed ? popup : null;
    if (!existing) {
      existing = window.open("", WINDOW_NAME);
    }
    if (!existing || existing.closed) return false;
    try {
      const href = String(existing.location?.href || "");
      if (href === "about:blank") {
        existing.close();
        return false;
      }
    } catch {
      // Same-name window from another origin still gets focus below.
    }
    popup = existing;
    try { existing.focus(); } catch {}
    try { existing.postMessage({ type: "raise" }, "*"); } catch {}
    channel.postMessage({ type: "focus" });
    return true;
  };

  const openFresh = () => {
    popup = window.open("/ui/call", WINDOW_NAME, "popup=yes,width=420,height=740");
    if (popup) popup.focus();
    else showPopupHint();
  };

  const openCall = () => {
    const state = localStorage.getItem("support-call-state") || "idle";
    if (state === "live" || state === "connecting") {
      if (raisePopup()) return;
      channel.postMessage({ type: "focus" });
      let heard = false;
      const wait = (event) => {
        if (event.data?.type === "focused" || event.data?.state) heard = true;
      };
      channel.addEventListener("message", wait);
      setTimeout(() => {
        channel.removeEventListener("message", wait);
        if (!heard) {
          try { localStorage.setItem("support-call-state", "idle"); } catch {}
          syncButtons(buttons, "idle");
          openFresh();
        }
      }, 350);
      return;
    }
    openFresh();
  };

  for (const button of buttons) {
    if (!button.querySelector("svg")) button.insertAdjacentHTML("afterbegin", PHONE_ICON);
    if (!button.querySelector(".label")) {
      const span = document.createElement("span");
      span.className = "label";
      span.textContent = "Call support";
      button.appendChild(span);
    }
    button.addEventListener("click", openCall);
  }
}

boot();
