async function loadSettings() {
  const settings = await API.req('/api/settings');
  if (!settings) return;
  for (const [key, value] of Object.entries(settings)) {
    const field = document.getElementById(key);
    if (field) field.value = value;
  }
  await loadRuntime();
}

async function loadRuntime() {
  const box = document.getElementById('runtime-box');
  const status = await API.req('/api/status');
  if (!status) {
    box.innerHTML = '<span class="info-val err">Could not load runtime status.</span>';
    return;
  }
  box.innerHTML = `
    <div class="info-row"><span class="info-key">aria2c</span><span class="info-val ${status.aria2_running ? 'ok' : 'err'}">${status.aria2_running ? 'running' : 'offline'}</span></div>
    <div class="info-row"><span class="info-key">download speed</span><span class="info-val">${fmtSpeed(status.download_speed || 0)}</span></div>
    <div class="info-row"><span class="info-key">upload speed</span><span class="info-val">${fmtSpeed(status.upload_speed || 0)}</span></div>
    <div class="info-row"><span class="info-key">active</span><span class="info-val">${status.num_active || 0}</span></div>
    <div class="info-row"><span class="info-key">waiting</span><span class="info-val">${status.num_waiting || 0}</span></div>
    <div class="info-row"><span class="info-key">stopped</span><span class="info-val">${status.num_stopped || 0}</span></div>`;
}

async function saveSettings(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  data.max_concurrent = Number(data.max_concurrent || 1);
  data.connections_per_file = Number(data.connections_per_file || 1);
  const ok = await API.req('/api/settings', 'PUT', data);
  if (ok) {
    toast('Settings saved', 'ok');
    await loadSettings();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('settings-form').addEventListener('submit', saveSettings);
  API.onProgress(loadRuntime);
  loadSettings();
  setInterval(loadRuntime, 5000);
});
