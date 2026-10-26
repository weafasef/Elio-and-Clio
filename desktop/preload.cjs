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
})
