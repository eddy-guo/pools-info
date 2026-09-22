await page.eval(() => {
  const mode = location.hostname === "www.poolsinfo.com" ? "before" : "after";
  const old = document.querySelector("#interaction-evidence");
  old?.remove();

  const families = [
    ["Primary", "button", "button", "Trade on Pools"],
    ["Accent CTA", "a", "leaderboard-cta", "Trader leaderboard"],
    ["Secondary", "button", "button secondary", "Connect wallet"],
    ["Ghost", "button", "connect-button", "Set my wallet"],
    ["Text ghost", "button", "text-button", "Clear"],
    ["Tab", "button", "tab-sample", "Gainers"],
    ["Segment", "button", "segment-sample", "USD"],
    ["Copy icon", "button", "icon-button", "⧉"],
    ["Explorer icon", "a", "icon-button", "↗"],
    ["Star icon", "button", "icon-button watch", "☆"],
  ];
  const states = ["Rest", "Hover", "Pressed", "Focus", "Disabled", "Selected"];
  const root = document.createElement("main");
  root.id = "interaction-evidence";
  root.dataset.mode = mode;
  root.innerHTML = `
    <style>
      html, body { background: #070708 !important; }
      body > *:not(#interaction-evidence) { display: none !important; }
      #interaction-evidence {
        --accent: #bbf451;
        --accent-deep: #192e03;
        --panel: #101014;
        --panel-hover: #121216;
        --surface-5: #1c1c22;
        --surface-6: #1e1e25;
        --line: #22222a;
        --line-hover: #33333d;
        --line-active: #2a2a33;
        --text: #f2f2f5;
        --text-2: #b4b4be;
        --text-3: #9a9aa4;
        display: block;
        width: min(1376px, calc(100vw - 64px));
        margin: 0 auto;
        padding: 32px 0 48px;
        color: var(--text);
        font-family: var(--font-geist), "Helvetica Neue", sans-serif;
      }
      #interaction-evidence h1 { margin: 0; font-size: 22px; line-height: 1.2; }
      #interaction-evidence .lede { margin: 7px 0 24px; color: var(--text-3); font-size: 13px; }
      #interaction-evidence .matrix {
        display: grid;
        grid-template-columns: 132px repeat(6, minmax(120px, 1fr));
        border: 1px solid var(--line);
        border-radius: 14px;
        overflow: hidden;
        background: #0b0b0d;
      }
      #interaction-evidence .head,
      #interaction-evidence .family,
      #interaction-evidence .cell {
        min-width: 0;
        min-height: 68px;
        padding: 12px;
        border-right: 1px solid #17171c;
        border-bottom: 1px solid #17171c;
      }
      #interaction-evidence .head {
        min-height: 42px;
        color: var(--text-3);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: .08em;
        text-transform: uppercase;
      }
      #interaction-evidence .family {
        display: flex;
        align-items: center;
        color: var(--text-2);
        font-size: 12px;
        font-weight: 600;
      }
      #interaction-evidence .cell {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #interaction-evidence .cell-label { display: none; }
      #interaction-evidence button,
      #interaction-evidence a { transition: none !important; text-decoration: none; }
      #interaction-evidence .button,
      #interaction-evidence .leaderboard-cta {
        display: inline-flex; align-items: center; justify-content: center;
        min-height: 36px; padding: 0 14px; border: 1px solid transparent;
        border-radius: 10px; background: var(--accent); color: var(--accent-deep);
        font-size: 12px; font-weight: 600; white-space: nowrap;
      }
      #interaction-evidence .button.secondary {
        background: var(--panel); color: var(--text); border-color: var(--line); font-weight: 500;
      }
      #interaction-evidence .connect-button {
        display: inline-flex; align-items: center; justify-content: center;
        height: 36px; min-width: 112px; padding: 0 12px; border: 1px solid var(--line);
        border-radius: 10px; background: var(--panel); color: var(--accent);
        font-size: 12px; font-weight: 600; white-space: nowrap;
      }
      #interaction-evidence .text-button {
        min-height: 32px; padding: 0; border: 0; border-radius: 4px;
        background: transparent; color: var(--text-3);
      }
      #interaction-evidence .tab-sample,
      #interaction-evidence .segment-sample {
        min-height: 32px; padding: 7px 11px; border: 0; border-radius: 9px;
        background: transparent; color: var(--text-3); font-size: 12px; font-weight: 600;
      }
      #interaction-evidence .segment-sample { border-radius: 7px; }
      #interaction-evidence .icon-button {
        display: inline-flex; align-items: center; justify-content: center;
        width: 32px; height: 32px; min-width: 32px; min-height: 32px; padding: 0;
        border: 0; border-radius: 7px; background: transparent; color: var(--text-3);
        font-size: 17px;
      }
      #interaction-evidence [data-state="focus"] {
        outline: 2px solid var(--accent) !important; outline-offset: 4px !important;
      }
      #interaction-evidence [data-state="disabled"] {
        cursor: not-allowed !important; opacity: .35 !important;
        box-shadow: none !important; filter: none !important;
      }
      #interaction-evidence [data-state="selected"].tab-sample,
      #interaction-evidence [data-state="selected"].segment-sample {
        background: var(--surface-6) !important; color: var(--text) !important;
      }
      #interaction-evidence [data-state="selected"].watch {
        background: transparent !important; color: var(--accent) !important;
      }
      #interaction-evidence [data-state="selected"]:not(.tab-sample):not(.segment-sample):not(.watch) {
        visibility: hidden;
      }
      #interaction-evidence[data-mode="before"] .button[data-state="hover"],
      #interaction-evidence[data-mode="before"] .button[data-state="pressed"] {
        background: #44303d !important; filter: brightness(1.08) !important;
      }
      #interaction-evidence[data-mode="before"] .button.secondary[data-state="hover"],
      #interaction-evidence[data-mode="before"] .button.secondary[data-state="pressed"] {
        border-color: var(--line-hover) !important;
      }
      #interaction-evidence[data-mode="before"] .leaderboard-cta[data-state="hover"],
      #interaction-evidence[data-mode="before"] .leaderboard-cta[data-state="pressed"] {
        filter: brightness(1.08) !important;
      }
      #interaction-evidence[data-mode="before"] .connect-button[data-state="hover"],
      #interaction-evidence[data-mode="before"] .connect-button[data-state="pressed"] {
        border-color: var(--line-hover) !important;
      }
      #interaction-evidence[data-mode="before"] .icon-button[data-state="hover"],
      #interaction-evidence[data-mode="before"] .icon-button[data-state="pressed"] {
        background: #302b33 !important; color: var(--text) !important;
      }
      #interaction-evidence[data-mode="after"] .button:not(.secondary)[data-state="hover"],
      #interaction-evidence[data-mode="after"] .leaderboard-cta[data-state="hover"] {
        background: var(--accent) !important; color: var(--accent-deep) !important;
        box-shadow: inset 0 0 0 2px var(--accent-deep) !important;
      }
      #interaction-evidence[data-mode="after"] .button:not(.secondary)[data-state="pressed"],
      #interaction-evidence[data-mode="after"] .leaderboard-cta[data-state="pressed"] {
        background: var(--accent-deep) !important; color: var(--accent) !important;
        box-shadow: inset 0 0 0 1px var(--accent) !important;
      }
      #interaction-evidence[data-mode="after"] .button.secondary[data-state="hover"],
      #interaction-evidence[data-mode="after"] .connect-button[data-state="hover"] {
        background: var(--panel-hover) !important; border-color: var(--line-hover) !important;
      }
      #interaction-evidence[data-mode="after"] .button.secondary[data-state="pressed"] {
        background: var(--surface-6) !important; border-color: var(--line-active) !important;
      }
      #interaction-evidence[data-mode="after"] .connect-button[data-state="pressed"],
      #interaction-evidence[data-mode="after"] .text-button[data-state="pressed"] {
        background: var(--surface-5) !important;
      }
      #interaction-evidence[data-mode="after"] .connect-button[data-state="pressed"] {
        border-color: var(--line-active) !important;
      }
      #interaction-evidence[data-mode="after"] .text-button[data-state="hover"],
      #interaction-evidence[data-mode="after"] .tab-sample[data-state="hover"],
      #interaction-evidence[data-mode="after"] .segment-sample[data-state="hover"] {
        background: var(--panel-hover) !important; color: var(--text-2) !important;
      }
      #interaction-evidence[data-mode="after"] .tab-sample[data-state="pressed"] {
        background: var(--surface-6) !important; color: var(--text) !important;
      }
      #interaction-evidence[data-mode="after"] .segment-sample[data-state="pressed"],
      #interaction-evidence[data-mode="after"] .icon-button[data-state="pressed"] {
        background: var(--surface-5) !important; color: var(--text) !important;
      }
      #interaction-evidence[data-mode="after"] .icon-button[data-state="hover"] {
        background: var(--surface-6) !important; color: var(--text) !important;
      }
      @media (max-width: 600px) {
        #interaction-evidence { width: calc(100vw - 28px); padding: 20px 0 32px; }
        #interaction-evidence h1 { font-size: 18px; }
        #interaction-evidence .lede { margin-bottom: 16px; line-height: 1.45; }
        #interaction-evidence .matrix { display: block; overflow: visible; border-radius: 12px; }
        #interaction-evidence .head { display: none; }
        #interaction-evidence .family {
          min-height: 38px; padding: 10px 12px; border-right: 0;
          background: #0e0e11; color: var(--text);
        }
        #interaction-evidence .cell {
          display: grid; grid-template-columns: 78px 1fr; min-height: 60px;
          padding: 8px 12px; border-right: 0; justify-items: start;
        }
        #interaction-evidence .cell-label {
          display: block; color: var(--text-3); font-size: 10px;
          font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
        }
        #interaction-evidence .cell > :last-child { justify-self: center; }
        #interaction-evidence .icon-button {
          width: 44px; height: 44px; min-width: 44px; min-height: 44px;
        }
      }
    </style>
    <h1>${mode === "before" ? "Production before" : "Local after"} - button interaction states</h1>
    <p class="lede">1440px and true 390px evidence - lime accent retained, geometry fixed across states.</p>
    <section class="matrix"></section>`;

  const matrix = root.querySelector(".matrix");
  const corner = document.createElement("div");
  corner.className = "head";
  corner.textContent = "Class";
  matrix.append(corner);
  for (const state of states) {
    const head = document.createElement("div");
    head.className = "head";
    head.textContent = state;
    matrix.append(head);
  }
  for (const [family, tag, className, label] of families) {
    const familyCell = document.createElement("div");
    familyCell.className = "family";
    familyCell.textContent = family;
    matrix.append(familyCell);
    for (const state of states) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const stateLabel = document.createElement("span");
      stateLabel.className = "cell-label";
      stateLabel.textContent = state;
      const control = document.createElement(tag);
      control.className = className;
      control.dataset.state = state.toLowerCase();
      control.textContent = family === "Star icon" && state === "Selected" ? "★" : label;
      control.setAttribute("aria-label", `${family} ${state}`);
      if (state === "Disabled") {
        if (tag === "button") control.disabled = true;
        else control.setAttribute("aria-disabled", "true");
      }
      cell.append(stateLabel, control);
      matrix.append(cell);
    }
  }
  document.body.append(root);
  scrollTo(0, 0);
});

console.log(await page.eval(() => document.querySelector("#interaction-evidence").dataset.mode));
