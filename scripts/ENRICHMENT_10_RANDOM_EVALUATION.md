# Enrichment script – 10 random entries evaluation

**Run:** `node scripts/enrich-music.cjs 10 --random`  
**Date:** 2026-03-08  
**Sample:** 10 of 3,672 unique artist/album groups (random sample)

---

## Summary

| Metric | Result |
|--------|--------|
| **Match rate** | 10/10 (100%) |
| **Source** | All matches from MusicBrainz (unified-search) |
| **Confidence range** | 100–150 (threshold 80) |
| **Entries with extra artwork** | 5 (Dido, Carlito, Beethoven Mehrstimmige, 4 Non Blondes; DJ Slon / Jan Wayne had 2 candidates but log shows 0 or 1 extra) |

---

## Per-entry notes

1. **Dido - Isobel.mp3** – Matched MB (110). Discogs also returned 2005 Greece Sampler. Album in DB is filename; match is likely single/release containing track. ✓ +1 extra.
2. **Carlito - Who's that boy ( Radio Edit ).mp3** – MB 150, Discogs 90. ✓ +1 extra.
3. **DJ Slon - Brigada.mp3** – MB 100, 2 MB candidates same ID. ✓ No extra.
4. **Jan Wayne Feat. Charlene - Trance Voices** – MB 100. ✓ 2 candidates same ID.
5. **08 Walisische Lieder WoO 155 - Ludwig van Beethoven** – MB 150. Classical; title-as-album. ✓ 1 candidate.
6. **14 Mehrstimmige Gesange - Ludwig van Beethoven** – MB 150, 2 MB releases. ✓ +1 extra.
7. **4 Non Blondes - Whats Up.mp3** – MB 110; 4 candidates above threshold (2 MB, 2 Discogs). ✓ +2 extra.
8. **Oceanlab - Trance Voices** – MB 150. Same MB release as #9.
9. **Starsplash - Trance Voices** – MB 150. **Same MB release ID as Oceanlab** (`10b2966e-be29-442d-a26e-cc1758290588`). Plausible if “Trance Voices” is one compilation; otherwise possible wrong match for one artist.
10. **Jean Sibelius - Classical Music Top 100** – MB 150. ✓ 2 candidates.

---

## Findings

- **Random sampling:** `--random` works; 10 random artist/album groups were processed.
- **Match quality:** All 10 above threshold; MusicBrainz dominated (Discogs present in results but lower or tied, so MB chosen).
- **Artwork:** Primary + `coverArtworkExtra` stored when multiple candidates above threshold (e.g. 4 Non Blondes +2 extra).
- **Edge cases:**
  - **Filename as album** (e.g. `Isobel.mp3`, `Whats Up.mp3`): Still matched; MB search by “Artist – Album” finds releases containing that track.
  - **Shared release for different artists:** Oceanlab and Starsplash both mapped to the same “Trance Voices” MB release. Acceptable for a shared compilation; if they have separate albums with the same name, one could be wrong.
- **No failures:** No 403/5xx, no “Not found”, no confidence below 80.

---

## Recommendations

1. **Optional:** For “Trance Voices”–style compilations, consider treating same release ID across different artist/album keys as expected (no change) or add a note in UI when artwork is shared.
2. **Optional:** Log or persist final run stats (e.g. `found`, `notFound`, `withArt`, `byMethod`) at end of script for easier evaluation.
3. **Keep:** Current threshold and multi-source logic; 10/10 match with no false low-confidence.

---

*Generated after running enrichment with `10 --random`.*
