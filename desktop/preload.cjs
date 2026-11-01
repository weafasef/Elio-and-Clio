'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ehPet', {
  setIgnoreMouseEvents(ignore) {
    ipcRenderer.send('pet:set-ignore-mouse', Boolean(ignore))
  },
  dragStart() {
    ipcRenderer.send('pet:drag-start')
  },
  dragEnd() {
    ipcRenderer.send('pet:drag-end')
  },
  setScale(percent) {
    ipcRenderer.send('pet:set-scale', Number(percent))
  },
  requestMicrophone() {
    return ipcRenderer.invoke('pet:request-microphone')
  },
  onVoiceStart(callback) {
    ipcRenderer.on('pet:voice-start', () => callback())
  },
  onVoiceStop(callback) {
    ipcRenderer.on('pet:voice-stop', () => callback())
  },
  onVoiceHotkeyMode(callback) {
    ipcRenderer.on('pet:voice-hotkey-mode', (_event, state) => callback(state))
  },
  reportVoiceState(state) {
    ipcRenderer.send('pet:voice-state', state)
  },
  onUiState(callback) {
    ipcRenderer.on('pet:ui-state', (_event, state) => callback(state))
  },
  getShortcuts() {
    return ipcRenderer.invoke('pet:get-shortcuts')
  },
  saveShortcuts(shortcuts) {
    return ipcRenderer.invoke('pet:save-shortcuts', shortcuts)
  },
  closeShortcuts() {
    ipcRenderer.send('pet:close-shortcuts')
  },
  retry() {
    ipcRenderer.send('pet:retry')
  },
  applyBodyControl(command) {
    return ipcRenderer.invoke('pet:body-control', command)
  },
})
