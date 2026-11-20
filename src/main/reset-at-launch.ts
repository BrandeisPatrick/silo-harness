// Runs when index.ts loads, right after carry-over.ts and before any other module reads the data folder: carries out
// a reset the last instance asked for (reset.ts). What goes is moved aside here and sent to the Trash once the app is
// ready (finishReset in index.ts).
import { app } from 'electron';
import { stageReset } from './reset';

stageReset(app.getPath('userData'), (line) => console.log(line));
