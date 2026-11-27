# js-bach
A verified, music-aware compiler and JavaScript runtime for the works of J.S. Bach.

[Listen online](https://mokele-mbembe.github.io/js-bach/)

## Play BWV 846–877

With Node.js 22 or later, install the dependencies and start the local demo.

```sh
npm ci
npm run demo
```

Open the local player and select Prelude or Fugue for any work in The Well-Tempered Clavier, Book I (BWV 846–869), or for the first eight works in Book II (BWV 870–877). The BWV 846–849 fugues offer solos that start at the selected voice’s first entry and preserve its later rests. Changing the work, movement, or solo selection stops the current playback. [Local player](http://127.0.0.1:4173/)

In BWV 846–849, choose **Fugue → All voices** to see the parts on one piano roll. Notes at the playhead brighten while they last. Simultaneous notes of the same pitch occupy separate bands, and the voice mixer dims or restores a part while playback continues. In BWV 846–848, the dashed markers identify the opening subject and answer entrances. [Ebenezer Prout's analysis, Fugues 1–3](https://waltercosand.com/CosandScores/Composers%20L-P/Composers_P/Prout%2C%20Ebenezer/Prout-Analysis_of_Bach%27s_48_Fugues.pdf)

The player follows simple written repeats, joins tied notes across measures, and schedules triangle oscillators with Web Audio. At a repeat jump, a tie continues when the next performed measure supplies its matching continuation. A tie stop whose start was skipped sounds as a new note. Playback uses the selected score's tempo and plays the main written notes at ornaments. The Score IR preserves grace notes as zero-duration events, which the demo skips during playback. [Performance conversion](src/performance.ts) · [Web Audio scheduler](src/oscillator-player.ts)

The player loads the catalog and selects the BWV 846 prelude by default. It requests one playback file at a time, cancels an unfinished download on selection changes, and keeps completed downloads available for return visits. The measure map marks rhythm template references. The fragment list shows each selected fragment’s voice, measure range, and transposition in semitones. Every movement displays the ordinary event stream and both encoded Brotli sizes.

### Build the static demo

`npm run build:pages` writes the player and its catalog and playback files to `dist/pages/`. The relative URLs work under a project path. `npm run test:pages` serves that directory under a nested path and checks playback in Chromium. Install the Playwright browser with `npm exec -- playwright install --only-shell chromium` when running this check for the first time.

The **Verify corpus** workflow builds and tests the static demo from the verified corpus generation. On `main`, **Deploy browser demo** uses that workflow and deploys the checked artifact to GitHub Pages. The live player links to its license and the corresponding source archive for the deployed commit. [Pages deployment workflow](.github/workflows/pages.yml)

## Play from a browser app

The locally packed npm preview includes an ESM entry with TypeScript declarations. Install the tarball in your browser app and call `play` from a user interaction.

```js
import { play, stop } from "@mokele-mbembe/js-bach";

document.querySelector("#play").addEventListener("click", () => {
  play("bwv846").catch((error) => {
    if (error.name !== "AbortError") console.error(error);
  });
});
document.querySelector("#stop").addEventListener("click", stop);
```

The first call starts the prelude and downloads its playback data on demand. To hear just the alto of the BWV 846 fugue, call `play("bwv846", { movement: "fugue", voice: "Alto" })`. [Browser API and installed preview guide](docs/npm-preview.md)

The locally built package also exports `getVoices` and `getPerformance` for voice controls and visualization. `play` returns a handle with `setVoiceMuted` for movements with named voices. [Programmable voices](docs/npm-preview.md#programmable-voices)

## Pack the npm preview

Run `npm run pack:preview` to build and write the installable tarball to `dist/npm/`. The tarball includes the player, one generated corpus, the corresponding source, and per-movement license notices. After installing the tarball, run `npm exec -- js-bach` from the installation directory. [Installed preview guide](docs/npm-preview.md)

### Release a preview on npm

Set a new version in `package.json` and `package-lock.json` with `npm version <version> --no-git-tag-version` and merge the release commit into `main`. The **Verify corpus** workflow uploads the tarball, the `npm pack --dry-run` file list, and `size-report.md` as the `npm-preview` artifact. The job summary reports the tarball download size, unpacked size, and response sizes for requests Playwright observes through the first scheduled oscillator in the BWV 846 prelude. Review the size report and the bundled `SCORE-LICENSES.md`.

For the first release through GitHub Actions, add a Trusted Publisher in the npm settings for `@mokele-mbembe/js-bach`. Select GitHub Actions, use `mokele-mbembe` as the owner, `js-bach` as the repository, and `publish.yml` as the workflow filename. Enable **Allow npm publish**. Complete the first release within two days of saving the binding. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

From GitHub Actions, select **Publish npm preview**, choose `main`, and click **Run workflow**. It verifies the corpus and publishes the checked tarball to `preview` using the workflow's OIDC identity. [Release workflow](.github/workflows/publish.yml)

## Import the corpus

With Node.js 22 or later installed, run `npm ci` from the repository root. To add a work, create `corpus/bwv<NUMBER>/` with the original `.mxl` files, reference MIDI, and `sources.json`. The scripts discover works by directory and check that the manifest identifies both movements. Use an existing [split-score manifest](corpus/bwv861/sources.json) or [combined-score manifest](corpus/bwv862/sources.json) as a guide. Review the edition, redistribution terms, and expected MIDI differences before adding a source.

### Audit candidate sources

Run the audit with `curl` on your `PATH`. PDMX sources also use `tar`.

```sh
npm run audit:sources -- corpus/bwv876/sources.json corpus/bwv877/sources.json
```

The command accepts new candidate JSON files anywhere on disk. Give each file a string `bwv` and one or both `movements`, each with `kind` set to `prelude` or `fugue`, a `score` object, and a `referenceMidi` object.

| Source pair | Required input per movement |
| --- | --- |
| Noctave / Mutopia | The direct `.mxl` URL in `score.download` and the direct `.mid` URL in `referenceMidi.download`. |
| Artform / PDMX v9 | The direct `.mxl` URL in `score.download` and the exact MuseScore ID as a string in `referenceMidi.pdmxScoreId`. Existing manifest fields `pdmxMetadata` and `archiveMember` also work. |
| PDMX v9 MusicXML / MIDI | The exact MuseScore ID as a string in `score.pdmxScoreId` and `referenceMidi.pdmxScoreId`. Each asset also accepts its own `pdmxMetadata` or `archiveMember` selector. |

When movements share a file, give each its own `score.measureRange` or `referenceMidi.tickRange`. Use half-open `[start, end]` bounds with zero-based MusicXML measure indices and native MIDI ticks. An optional `source` URL provides the upstream page for review. An optional SHA-256 pins the expected bytes.

The audit compares MIDI against the performed repeat order by default. Set `referenceMidi.repeatMode` to `"written"` when the upstream MIDI plays each written measure once, as in the BWV 871 prelude. The player follows the written repeat signs in either case.

The audit downloads the files into `dist/source-audit/bwv*/` and writes `attack-diff.md` and `attack-diff.json` with the calculated SHA-256 values, exact attack differences, possible notation matches, and separate license evidence for the MusicXML and MIDI. Use filenames that are unique even when compared without regard to case. In a batch, the command writes reports for successful candidates and exits with an error if any candidate failed. It verifies the PDMX v9 release files against their published sizes and MD5 checksums before caching them under `dist/source-audit/cache/`. The first audit using PDMX MusicXML also downloads the 1.9 GB MusicXML archive. Confirm the edition, redistribution terms, and explanations for differences before creating the final corpus manifest. [PDMX v9 release](https://zenodo.org/records/15571083)

### Audit musical voices

Run `audit:voices` with `curl` on your `PATH` to compare a corpus movement with a voice-separated engraving.

```sh
npm run audit:voices -- bwv849-fugue
npm run audit:voices -- bwv867-fugue
```

The command writes `voice-audit.md` and `voice-audit.json` in a new directory under `dist/voice-audit/`. It compares written onset, duration, and MIDI pitch on a common integer tick grid, retaining each simultaneous unison and both ends of every written tie. For unisons spanning several reference voices, it assigns a voice only when matching tie evidence distinguishes it. The report lists unresolved assignments, differences in note multiplicity, and differences in written ties. It flags score labels that identify different musical voices within one measure, including cases at the same onset. When the full assignment fits the current manifest format, it checks that the playback compiler preserves the performed note spans. For movements with curated voice groups, it verifies the existing mapping separately against the reference's written segments and ties.

BWV 849 uses the credited Mutopia engraving. BWV 867 uses the five-staff BWV 867 engraving from Kyle Rother's Book I archive. The presets verify the downloaded SHA-256 checksums. [Mutopia](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=596) · [University of Cape Town](https://open.uct.ac.za/items/d2a6887b-7196-4fbe-8b56-a469bf557f93)

To check a different corpus movement, pass `--reference <config.json>`. The config gives `source`, `credit`, `license`, and a `voices` object mapping LilyPond variables to musical voice IDs. Supply either `download` or a `file` path relative to the config. Use `archiveMember` for a ZIP input, `sha256` to pin the input, and `memberSha256` to pin the extracted file. The reader supports selected, inline `\relative` voice lines with explicit starting pitches and written notes, rests, skips, and ties. Unsupported LilyPond notation produces an error.

### Verify and build

Check just the works you are reviewing, then regenerate the complete comparison and demo data.

```sh
npm run check:corpus -- 876 877
npm run build:corpus
```

Omit the BWV numbers to check every work's attack baseline. The build reuses each unchanged movement's transposition search and still checks both round-trips and recalculates the Brotli sizes. Use `npm run build:corpus -- --fresh` to rerun every search. For demo changes using already generated scores, `npm run demo:serve` recompiles the TypeScript and starts the player with the most recently published catalog. Restart the demo after publishing new scores.

`npm run verify` runs all tests and recomputes every transposition search. `npm run verify:cached` runs the same tests and keeps transposition search records in `dist/transposition-cache/`. The build checks each record against the imported Score IR, the encoder fingerprint, and its checksum. On a hit, it still checks both lossless round trips and playback decoding and recomputes the Brotli sizes. It reports cache hits and recomputes searches for movements with missing or invalid records.

GitHub Actions restores only those search records for verification and Pages builds. Successful branch pushes can save them in GitHub's branch-scoped cache, and pull requests only restore them. For a cold Pages rebuild on `main`, manually run **Deploy browser demo** with **Recompute all transposition searches** enabled. The npm publish workflow always runs cold verification. The comparison table is attached to the verification run.

The build writes one playback JSON per movement, the catalog, the comparison report, and the local manifest snapshots and transposition cache to a new directory under `dist/corpus/builds/`. It atomically updates `dist/corpus/current` once every file is ready. Older directories remain available to running demos. The importer accepts the pitched, single-part MusicXML 3.1 and 4.0 subsets used by the corpus. For works published in a single MusicXML archive, the manifest gives the measure ranges for the two movements. Score IR uses integer ticks and retains each note’s written pitch, voice, staff, ties, and notation marks. The build expands repeats and joins ties once when producing playback data, then checks that decoding the playback file preserves each note’s exact timing, pitch, and voice. [MVP plan](docs/mvp.md)

For the fugues with voice groups, the manifest maps exported labels to musical voices. `voiceOverrides` records cases where the same exported label belongs to a different musical voice in specific written measures. The BWV 847–849 assignments were checked against the independently written lines in the credited Mutopia engravings. A tied note keeps the export label of its attack, and the build checks that the continuation stays in the same musical voice. [BWV 847 engraving](https://www.mutopiaproject.org/ftp/BachJS/BWV847/fuga2/fuga2.ly) · [BWV 848 engraving](https://www.mutopiaproject.org/ftp/BachJS/BWV848/bwv848b/bwv848b.ly) · [BWV 849 engraving](https://www.mutopiaproject.org/ftp/BachJS/BWV849/bwv849b/bwv849b.ly)

`noteOverrides` assigns a `voiceId` to an individual written segment using `measure`, measure-relative `offsetTicks`, `scoreVoice`, and `midiPitch`. Each rule must select exactly one positive-duration, non-grace note before repeats are expanded. The compiler uses `noteOverrides` first, then measure-level `voiceOverrides`, then the default `voices` mapping. Every segment in a tie chain must resolve to the same musical voice.

The tests check the original file hashes and compare distinct metered `(start tick, MIDI pitch)` pairs against the upstream reference MIDI using its repeat order. The Score IR keeps repeat marks on their written measures. The manifests record expected differences from overlapping notes, realized ornaments, played grace notes, an arpeggiated chord, and reattacks at written ties. The BWV 876 and 877 preludes also pin each shifted attack to its exact written tick, MIDI tick, and pitch. The BWV 870 fugue's reference MIDI contains a redundant note-off, which the audit reports separately. The BWV 852 prelude also pins the 15 attacks omitted from the PDMX MIDI and verified against the printed OpenWTC edition in measures 63–64. [Importer tests](test/import-mxl.test.ts) · [OpenWTC printed edition](https://upload.wikimedia.org/wikipedia/commons/d/d8/J.S._Bach_-_The_Well-Tempered_Clavier%2C_Book_1_-_OpenWTC.pdf#page=58)

## Compare rhythm encoding

`npm run build:corpus` expands the rhythm encoding and checks every field against the original Score IR. A template shares timing, rests, voices, ties, and notation marks only when those fields match. Each reference stores its own written pitches in event order. [Rhythm codec](src/rhythm-templates.ts) · [Round-trip tests](test/rhythm-templates.test.ts)

The build prints the Brotli sizes and the path to the published `compression.md` table for all 64 movements. The comparison uses compact UTF-8 JSON for the event stream and each encoding, with Brotli text mode and quality 11. The playback files carry the numbers used in the demo.

## Compare transposed fragments

The transposition search groups metered pitched notes by exported voice ID and slides over 4–16 successive note positions on the score timeline, including written tie continuations. Matches share relative onset, duration, chromatic and diatonic intervals, ties, notation, and relative staff changes. Occurrences carry absolute anchors and event positions, which let the decoder restore spelling and event order across barlines. Rests and grace notes stay in their original positions.

Each search step excludes already claimed events, ranks candidates by estimated JSON savings, and Brotli-compresses the 24 best candidates with the same parameters as the report. It keeps the best strict improvement per step. The build checks the expanded Score IR and reports fragment bytes alongside the event stream and rhythm encoding. [Fragment codec](src/transposed-fragments.ts) · [Fragment tests](test/transposed-fragments.test.ts)

## Score credits

Johann Sebastian Bach composed all 64 movements. The redistributed files retain their upstream terms. BWV 846 includes CC0 and public-domain scores. The BWV 847 and 850 preludes and both movements of BWV 848, 849, 851, 853, 855, 856, 860, 861, and 865 are marked public domain. Each manifest records the edition and typesetter. [BWV 846 sources](corpus/bwv846/sources.json) · [BWV 847 sources](corpus/bwv847/sources.json) · [BWV 848 sources](corpus/bwv848/sources.json) · [BWV 849 sources](corpus/bwv849/sources.json) · [BWV 850 sources](corpus/bwv850/sources.json) · [BWV 851 sources](corpus/bwv851/sources.json) · [BWV 853 sources](corpus/bwv853/sources.json) · [BWV 855 sources](corpus/bwv855/sources.json) · [BWV 856 sources](corpus/bwv856/sources.json) · [BWV 860 sources](corpus/bwv860/sources.json) · [BWV 861 sources](corpus/bwv861/sources.json) · [BWV 865 sources](corpus/bwv865/sources.json)

For Book II, BWV 870 and 871 use public-domain Noctave MusicXML and MIDI from the same Mutopia editions. [BWV 870 sources](corpus/bwv870/sources.json) · [BWV 871 sources](corpus/bwv871/sources.json)

BWV 872 and 873 use verits99's CC0 1.0 MuseScore edition. PDMX v9 supplies both MusicXML and MIDI from the same entry for each movement. The original exports use Harp as the playback instrument and retain the keyboard staves and written keys. [BWV 872 sources](corpus/bwv872/sources.json) · [BWV 873 sources](corpus/bwv873/sources.json)

BWV 874 uses verits99's combined harpsichord edition. The BWV 875 fugue uses verits99's separate MuseScore edition. PDMX v9 supplies the CC0 MusicXML and MIDI for both. The BWV 875 prelude uses the public-domain Noctave MusicXML and the corresponding Mutopia MIDI from Gwenaël Joret's engraving of the 1866 Bach-Gesellschaft edition. [BWV 874 sources](corpus/bwv874/sources.json) · [BWV 875 sources](corpus/bwv875/sources.json)

BWV 876 and 877 use verits99's CC0 1.0 MuseScore edition. PDMX v9 supplies separate MusicXML and MIDI files for each movement. Their written attacks agree with both combined editions for each work in PDMX. [BWV 876 sources](corpus/bwv876/sources.json) · [BWV 877 sources](corpus/bwv877/sources.json)

BWV 852, 854, 858, 859, 862–864, and 866–869 use Olivier Miquel’s CC0 Open Well-Tempered Clavier edition. PDMX supplies the reference MIDI for these works and the MusicXML for BWV 858 and 868. Artform supplies the MusicXML for BWV 852, 854, 859, 862–864, 866, 867, and 869. [BWV 852 sources](corpus/bwv852/sources.json) · [BWV 854 sources](corpus/bwv854/sources.json) · [BWV 858 sources](corpus/bwv858/sources.json) · [BWV 859 sources](corpus/bwv859/sources.json) · [BWV 862 sources](corpus/bwv862/sources.json) · [BWV 863 sources](corpus/bwv863/sources.json) · [BWV 864 sources](corpus/bwv864/sources.json) · [BWV 866 sources](corpus/bwv866/sources.json) · [BWV 867 sources](corpus/bwv867/sources.json) · [BWV 868 sources](corpus/bwv868/sources.json) · [BWV 869 sources](corpus/bwv869/sources.json) · [OpenWTC edition](https://welltemperedclavier.org/) · [PDMX data release](https://doi.org/10.5281/zenodo.15571083)

The MusicXML, reference MIDI, and generated score data for the BWV 847 and 850 fugues and both BWV 857 movements are distributed under CC BY-SA 4.0. The BWV 847 edition is credited to Urs Metzger / Mutopia Project (Mutopia-2014/03/02-1941). The BWV 850 fugue (Mutopia-2018/10/08-2233) and the BWV 857 prelude (Mutopia-2018/06/04-2226) and fugue (Mutopia-2018/06/04-2225) are credited to Sven Reichard / Mutopia Project. Noctave converted the Mutopia engravings to MusicXML, and js-bach converts the MusicXML into score data. The project code uses GPLv3. [BWV 847 Noctave edition](https://noctavepiano.com/en/free-library/bach-das-wohltemperierte-clavier-i-fuga-ii-bwv-847/) · [BWV 850 Noctave edition](https://noctavepiano.com/en/free-library/bach-das-wohltemperierte-clavier-i-fuga-v-bwv-850/) · [BWV 857 sources](corpus/bwv857/sources.json) · [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) · [Code license](LICENSE)
