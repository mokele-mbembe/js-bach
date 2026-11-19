# js-bach
A verified, music-aware compiler and JavaScript runtime for the works of J.S. Bach.

## Play BWV 846–869

With Node.js 22 or later, install the dependencies and start the local demo.

```sh
npm ci
npm run demo
```

Open the local player, choose any of the 24 works in The Well-Tempered Clavier, Book I (BWV 846–869), and select Prelude or Fugue. The BWV 846 and 847 fugues also offer solos that start at the selected voice’s first entry and preserve its later rests. Changing the work, movement, or voice stops the current playback. [Local player](http://127.0.0.1:4173/)

The player follows simple written repeats, joins tied notes across measures, and schedules triangle oscillators with Web Audio. At a repeat jump, a tie continues when the next performed measure supplies its matching continuation. A tie stop whose start was skipped sounds as a new note. Playback uses the selected score's tempo and plays the main written notes at ornaments. The Score IR preserves grace notes as zero-duration events, which the demo skips during playback. [Performance conversion](src/performance.ts) · [Web Audio scheduler](src/oscillator-player.ts)

The player expands the smaller encoded representation of each movement before playback. The measure map marks rhythm template references. The fragment list shows each selected fragment’s voice, measure range, and transposition in semitones. Every movement displays the ordinary event stream and both encoded Brotli sizes.

## Import the corpus

With Node.js 22 or later installed, run `npm ci` from the repository root. To add a work, create `corpus/bwv<NUMBER>/` with the original `.mxl` files, reference MIDI, and `sources.json`. The scripts discover works by directory and check that the manifest identifies both movements. Use an existing [split-score manifest](corpus/bwv861/sources.json) or [combined-score manifest](corpus/bwv862/sources.json) as a guide. Review the edition, redistribution terms, and expected MIDI differences before adding a source.

### Audit candidate sources

Run the audit with `curl` on your `PATH`. PDMX sources also use `tar`.

```sh
npm run audit:sources -- corpus/bwv868/sources.json corpus/bwv869/sources.json
```

The command accepts new candidate JSON files anywhere on disk. Give each file a string `bwv` and one or both `movements`, each with `kind` set to `prelude` or `fugue`, a `score` object, and a `referenceMidi` object.

| Source pair | Required input per movement |
| --- | --- |
| Noctave / Mutopia | The direct `.mxl` URL in `score.download` and the direct `.mid` URL in `referenceMidi.download`. |
| Artform / PDMX v9 | The direct `.mxl` URL in `score.download` and the exact MuseScore ID as a string in `referenceMidi.pdmxScoreId`. Existing manifest fields `pdmxMetadata` and `archiveMember` also work. |
| PDMX v9 MusicXML / MIDI | The exact MuseScore ID as a string in `score.pdmxScoreId` and `referenceMidi.pdmxScoreId`. Each asset also accepts its own `pdmxMetadata` or `archiveMember` selector. |

When movements share a file, give each its own `score.measureRange` or `referenceMidi.tickRange`. Use half-open `[start, end]` bounds with zero-based MusicXML measure indices and native MIDI ticks. An optional `source` URL provides the upstream page for review. An optional SHA-256 pins the expected bytes.

The audit downloads the files into `dist/source-audit/bwv*/` and writes `attack-diff.md` and `attack-diff.json` with the calculated SHA-256 values, exact attack differences, possible notation matches, and separate license evidence for the MusicXML and MIDI. Use filenames that are unique even when compared without regard to case. In a batch, the command writes reports for successful candidates and exits with an error if any candidate failed. It verifies the PDMX v9 release files against their published sizes and MD5 checksums before caching them under `dist/source-audit/cache/`. The first audit using PDMX MusicXML also downloads the 1.9 GB MusicXML archive. Confirm the edition, redistribution terms, and explanations for differences before creating the final corpus manifest. [PDMX v9 release](https://zenodo.org/records/15571083)

### Verify and build

Check just the works you are reviewing, then regenerate the complete comparison and demo data.

```sh
npm run check:corpus -- 868 869
npm run build:corpus
```

Omit the BWV numbers to check every work's attack baseline. The build reuses each unchanged movement's transposition search and still checks both round-trips and recalculates the Brotli sizes. Use `npm run build:corpus -- --fresh` to rerun every search. For demo changes using already generated scores, `npm run demo:serve` recompiles the TypeScript and starts the player with the most recently published catalog. Restart the demo after publishing new scores.

`npm run verify` runs all tests and a fresh corpus build. GitHub Actions runs it on pushes and pull requests and attaches the comparison table to the job.

The build writes the Score IR, source manifests, encodings, catalog, and report to a new directory under `dist/corpus/builds/`. It atomically updates `dist/corpus/current` to the directory name once every file is ready. Older directories remain available to running demos. The importer accepts the pitched, single-part MusicXML 3.1 and 4.0 subsets used by the corpus. For works published in a single MusicXML archive, the manifest gives the measure ranges for the two movements. The output uses integer ticks, with a quarter-note division for the score, a start tick for each measure, and a measure-relative offset for each note or rest. Notes retain their written pitch, voice, staff, ties, and notation marks. Tempo comes from the imported edition when specified. [MVP plan](docs/mvp.md)

The tests check the original file hashes and compare distinct metered `(start tick, MIDI pitch)` pairs against the upstream reference MIDI. The Score IR keeps repeat marks on their written measures. Playback and the MIDI attack comparison expand them in performance order. The manifests record expected differences from overlapping notes, realized ornaments, an arpeggiated chord, and a reattack at a written tie. The BWV 852 prelude also pins the 15 attacks omitted from the PDMX MIDI and verified against the printed OpenWTC edition in measures 63–64. [Importer tests](test/import-mxl.test.ts) · [OpenWTC printed edition](https://upload.wikimedia.org/wikipedia/commons/d/d8/J.S._Bach_-_The_Well-Tempered_Clavier%2C_Book_1_-_OpenWTC.pdf#page=58)

## Compare rhythm encoding

`npm run build:corpus` writes the template-encoded `.rhythm.json` files alongside the original Score IR. The build expands each encoded file and checks every Score IR field before writing the results. A template shares timing, rests, voices, ties, and notation marks only when those fields match. Each reference stores its own written pitches in event order. [Rhythm codec](src/rhythm-templates.ts) · [Round-trip tests](test/rhythm-templates.test.ts)

The build prints the Brotli sizes and the path to the published `compression.md` table for all 48 movements. It writes a `compression.json` file per work and compares compact UTF-8 JSON for the event stream and each encoding, with Brotli text mode and quality 11.

## Compare transposed fragments

The build also writes `.transposed.json` files. The search groups metered pitched notes by exported voice ID and slides over 4–16 successive note positions on the score timeline, including written tie continuations. Matches share relative onset, duration, chromatic and diatonic intervals, ties, notation, and relative staff changes. Occurrences carry absolute anchors and event positions, which let the decoder restore spelling and event order across barlines. Rests and grace notes stay in their original positions.

Each search step excludes already claimed events, ranks candidates by estimated JSON savings, and Brotli-compresses the 24 best candidates with the same parameters as the report. It keeps the best strict improvement per step. The build checks the expanded Score IR and reports fragment bytes alongside the event stream and rhythm encoding. [Fragment codec](src/transposed-fragments.ts) · [Fragment tests](test/transposed-fragments.test.ts)

## Score credits

Johann Sebastian Bach composed all 48 movements. The redistributed files retain their upstream terms. BWV 846 includes CC0 and public-domain scores. The BWV 847 and 850 preludes and both movements of BWV 848, 849, 851, 853, 855, 856, 860, 861, and 865 are marked public domain. Each manifest records the edition and typesetter. [BWV 846 sources](corpus/bwv846/sources.json) · [BWV 847 sources](corpus/bwv847/sources.json) · [BWV 848 sources](corpus/bwv848/sources.json) · [BWV 849 sources](corpus/bwv849/sources.json) · [BWV 850 sources](corpus/bwv850/sources.json) · [BWV 851 sources](corpus/bwv851/sources.json) · [BWV 853 sources](corpus/bwv853/sources.json) · [BWV 855 sources](corpus/bwv855/sources.json) · [BWV 856 sources](corpus/bwv856/sources.json) · [BWV 860 sources](corpus/bwv860/sources.json) · [BWV 861 sources](corpus/bwv861/sources.json) · [BWV 865 sources](corpus/bwv865/sources.json)

BWV 852, 854, 858, 859, 862–864, and 866–869 use Olivier Miquel’s CC0 Open Well-Tempered Clavier edition. PDMX supplies the reference MIDI for these works and the MusicXML for BWV 858 and 868. Artform supplies the MusicXML for BWV 852, 854, 859, 862–864, 866, 867, and 869. [BWV 852 sources](corpus/bwv852/sources.json) · [BWV 854 sources](corpus/bwv854/sources.json) · [BWV 858 sources](corpus/bwv858/sources.json) · [BWV 859 sources](corpus/bwv859/sources.json) · [BWV 862 sources](corpus/bwv862/sources.json) · [BWV 863 sources](corpus/bwv863/sources.json) · [BWV 864 sources](corpus/bwv864/sources.json) · [BWV 866 sources](corpus/bwv866/sources.json) · [BWV 867 sources](corpus/bwv867/sources.json) · [BWV 868 sources](corpus/bwv868/sources.json) · [BWV 869 sources](corpus/bwv869/sources.json) · [OpenWTC edition](https://welltemperedclavier.org/) · [PDMX data release](https://doi.org/10.5281/zenodo.15571083)

The MusicXML, reference MIDI, and generated score data for the BWV 847 and 850 fugues and both BWV 857 movements are distributed under CC BY-SA 4.0. The BWV 847 edition is credited to Urs Metzger / Mutopia Project (Mutopia-2014/03/02-1941). The BWV 850 fugue (Mutopia-2018/10/08-2233) and the BWV 857 prelude (Mutopia-2018/06/04-2226) and fugue (Mutopia-2018/06/04-2225) are credited to Sven Reichard / Mutopia Project. Noctave converted the Mutopia engravings to MusicXML, and js-bach converts the MusicXML into score data. The project code uses GPLv3. [BWV 847 Noctave edition](https://noctavepiano.com/en/free-library/bach-das-wohltemperierte-clavier-i-fuga-ii-bwv-847/) · [BWV 850 Noctave edition](https://noctavepiano.com/en/free-library/bach-das-wohltemperierte-clavier-i-fuga-v-bwv-850/) · [BWV 857 sources](corpus/bwv857/sources.json) · [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) · [Code license](LICENSE)
