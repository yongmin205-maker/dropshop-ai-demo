# Pilot 2 (Salon) — binary assets

Large assets (PNGs, PDFs) are not committed to git to avoid deploy timeouts. They live in the webdev storage bucket and are referenced by URL from this repo.

| File | Storage URL | Purpose |
|---|---|---|
| `mood_a_rosegold.png` | `/manus-storage/mood_a_rosegold_dd303239.png` | Moodboard option A — Rose gold tone |
| `mood_b_botanical.png` | `/manus-storage/mood_b_botanical_2fd0d0f2.png` | Moodboard option B — Modern Botanical (chosen) |
| `mood_c_editorial.png` | `/manus-storage/mood_c_editorial_86b840e5.png` | Moodboard option C — Editorial tone |
| `proposals/salon_mockup_overlap.png` | `/manus-storage/salon_mockup_overlap_c682579f.png` | Proposal UI mockup — overlap slot scenario |
| `proposals/salon_mockup_gapfiller.png` | `/manus-storage/salon_mockup_gapfiller_7d0895af.png` | Proposal UI mockup — daily gap-filler scenario |
| `proposals/salon_ai_proposal.pdf` | `/manus-storage/salon_ai_proposal_32734364.pdf` | 7-page proposal PDF (Korean, with embedded mockups) |

**Local fallback copy**: `/home/ubuntu/webdev-static-assets/mainstreet-ai/` (sandbox only; not persistent across sandbox rebuilds).

If the sandbox is rebuilt and these URLs 404, the canonical copies can be re-generated from the Notion "Pilot 2: Salon AI Scheduler" page (mood boards and PDF are attached there too).
