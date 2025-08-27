const socket = io();
const code = window.MACHINE_CODE;

function renderStatus(data){
  const row = document.getElementById("status_row");
  row.innerHTML = `
    <span class="mono badge">${data.count} / ${data.needed} connected</span>
    <span class="mono badge">All tested: ${data.remotes.length>0 && data.remotes.every(r=>r.tested) ? "Yes" : "No"}</span>
  `;
}

function renderGrid(state, list){
  const grid = document.getElementById("ref_grid");
  grid.innerHTML = "";
  const needed = state.num_refs_cfg;
  // Create N slots, fill from connected list
  for(let i=0;i<needed;i++){
    const r = list[i];
    const name = r ? r.name : `Referee ${i+1}`;
    const connected = !!r;
    const active = r?.active;
    const tested = r?.tested;

    const box = document.createElement("div");
    box.className = "ref-box";
    box.innerHTML = `
      <div class="ref-top">
        <div class="ref-name">${name}</div>
        <div class="lights">
          <span class="light ${connected ? "on blue":""}" title="Connected"></span>
          <span class="light ${active ? "on yellow":""}" title="Activity"></span>
        </div>
      </div>
      <div class="small">${tested ? "Tested ✅" : "Awaiting test"}</div>
    `;
    grid.appendChild(box);
  }
}

function gateProceed(data){
  const proceed = document.getElementById("proceed");
  const connectedEnough = data.count >= data.needed;
  const allTested = data.remotes.length>0 && data.remotes.every(r=>r.tested) && (data.count >= data.needed);
  proceed.disabled = !(connectedEnough && allTested);
}

socket.emit("operator_join", {code});

socket.on("state", ({state}) => {
  // initial fill if needed
});

socket.on("remote_status", (data) => {
  renderStatus(data);
  // fetch state again for numbers like required count
  socket.emit("operator_join", {code});
  socket.once("state", ({state})=>{
    renderGrid(state, data.remotes || []);
    gateProceed(data);
  });
});

document.getElementById("proceed").addEventListener("click", () => {
  socket.emit("operator_proceed_if_ready", {code});
});

socket.on("proceed_main", () => {
  window.location.href = "/operator/main";
});

socket.on("force_setup", () => {
  // already here
});
