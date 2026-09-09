'use strict';

class Plugin {
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
  registerInterval() {}
}
class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; }
}
class Setting {
  constructor() { return this; }
  setName() { return this; }
  setDesc() { return this; }
  addText(cb) { cb && cb({ setPlaceholder: () => ({ setValue: () => ({ onChange: () => {} }) }), setValue: () => ({ onChange: () => {} }), onChange: () => {}, inputEl: {} }); return this; }
  addToggle(cb) { cb && cb({ setValue: () => ({ onChange: () => {} }) }); return this; }
  addButton(cb) { cb && cb({ setButtonText: () => ({ onClick: () => {}, setCta: () => ({ onClick: () => {} }) }) }); return this; }
  addTextArea(cb) { cb && cb({ setValue: () => ({ onChange: () => {} }) }); return this; }
}
class Notice {
  constructor() {}
  setMessage() {}
  hide() {}
}

module.exports = { Plugin, PluginSettingTab, Setting, Notice };
