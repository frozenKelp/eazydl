async function loadSettings() {
  const settings = await getSettings(true);
  applyInterfaceSettings(settings);
  applySettingsToForm(settings);
  await loadRuntime();
}

function applySettingsToForm(settings) {
  document.querySelectorAll('[name]').forEach(field => {
    const value = settings[field.name];
    if (field.type === 'checkbox') {
      field.checked = boolSetting(value);
    } else if (value !== undefined) {
      field.value = value;
    }
  });
  syncLinkedNumbers();

  syncScaleLabel();
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

function collectSettings(form) {
  const data = {};
  [...form.elements].forEach(el => {
    if (!el.name) return;
    if (el.type === 'checkbox') {
      data[el.name] = el.checked ? 'true' : 'false';
    } else if (el.type === 'number' || el.type === 'range') {
      data[el.name] = Number(el.value || 0);
    } else {
      data[el.name] = el.value;
    }
  });
  return data;
}

async function saveSettings(e) {
  e.preventDefault();
  const data = collectSettings(e.currentTarget);
  const ok = await API.req('/api/settings', 'PUT', data);
  if (ok) {
    clearSettingsCache();
    toast('Settings saved', 'ok');
    await loadSettings();
  }
}

function showPanel(id) {
  document.querySelectorAll('[data-settings-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.settingsTab === id);
  });
  document.querySelectorAll('[data-settings-panel]').forEach(panel => {
    panel.hidden = panel.dataset.settingsPanel !== id;
  });
}

function syncScaleLabel() {
  const scale = document.getElementById('interface_scale');
  const label = document.getElementById('scale-value');
  if (scale && label) label.textContent = `${scale.value}%`;
}

function previewAppearance() {
  const scale = document.getElementById('interface_scale');
  syncScaleLabel();
  const form = document.getElementById('settings-form');
  if (!form) return;
  applyInterfaceSettings({ ...SETTINGS_DEFAULTS, ...collectSettings(form) });
}

function syncLinkedNumbers(source = null) {
  document.querySelectorAll('[data-linked-number]').forEach(numberInput => {
    const range = document.getElementById(numberInput.dataset.linkedNumber);
    if (!range) return;
    if (source === numberInput) range.value = numberInput.value;
    else numberInput.value = range.value;
  });
}

function bindLinkedNumbers() {
  document.querySelectorAll('[data-linked-number]').forEach(numberInput => {
    const range = document.getElementById(numberInput.dataset.linkedNumber);
    if (!range) return;
    range.addEventListener('input', () => {
      numberInput.value = range.value;
      previewAppearance();
    });
    numberInput.addEventListener('input', () => {
      range.value = numberInput.value;
      previewAppearance();
    });
  });
}

function resetSettingsForm() {
  applySettingsToForm(SETTINGS_DEFAULTS);
  applyInterfaceSettings(SETTINGS_DEFAULTS);
  toast('Defaults staged. Save to apply them.', 'info');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('settings-form').addEventListener('submit', saveSettings);
  document.getElementById('reset-settings-btn').addEventListener('click', resetSettingsForm);
  document.querySelectorAll('[data-settings-tab]').forEach(btn => {
    btn.addEventListener('click', () => showPanel(btn.dataset.settingsTab));
  });
  bindLinkedNumbers();
  document.getElementById('interface_scale').addEventListener('input', previewAppearance);
  document.getElementById('card_ratio_width').addEventListener('input', previewAppearance);
  document.getElementById('card_ratio_height').addEventListener('input', previewAppearance);
  showPanel('downloads');
  loadSettings();
  setInterval(loadRuntime, 5000);
});
