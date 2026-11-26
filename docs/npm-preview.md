# js-bach npm preview

The local player includes 64 movements from The Well-Tempered Clavier, BWV 846–877. It requires Node.js 22 or later and a browser with Web Audio.

Install the preview and start the player from your terminal.

```sh
npm install @mokele-mbembe/js-bach@preview
npm exec -- js-bach
```

Open the local address printed in the terminal. Choose a work and select Prelude or Fugue, then click **Play**. Changing the selection stops playback. The default address is `http://127.0.0.1:4173/`. Set `PORT` to use another port.

The TypeScript source, build scripts, and original score files are in `source/`. To rebuild from source, run `npm ci` and `npm run pack:preview` in that directory.

The player code is licensed under [GPL-3.0-only](LICENSE). The [score licenses and credits](SCORE-LICENSES.md) apply to the bundled score data and the original MusicXML and MIDI files.
