// The preload of a popup card's title bar (a small page of our own, see popups.ts): the bar's × and its drag handle
// reach the main process through one channel, which checks that the sender is a bar it made.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bar', {
  act: (action: string, dx?: number, dy?: number): void => ipcRenderer.send('browser:popup-bar', String(action), Number(dx) || 0, Number(dy) || 0),
});
