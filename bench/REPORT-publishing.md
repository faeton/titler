# Publishing targets: limits, APIs, covers (checked 2026-10-25)

Web research only. Two doc conflicts: YouTube `videos.insert` now says unverified-project uploads
are *not* forced private, while the revision history still carries the 2020 lock rule; Instagram
resumable upload (`rupload`) is documented for Facebook Login only — with Instagram Login Meta
must fetch a public `video_url`.

## Instagram

| | In-app | Content Publishing API |
|---|---|---|
| Reels | ≤ 20 min; > 3 min not recommended to new audiences ([features/reels](https://about.instagram.com/features/reels)) | 3 s – 15 min, ≤ 300 MB |
| Stories | 60 s per clip, longer split in-app ([features/stories](https://about.instagram.com/features/stories)) | 3 – 60 s, ≤ 100 MB, no auto-split |

Video spec ([ig-user/media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media)):
MP4/MOV, moov first, no edit lists, H.264/HEVC progressive closed-GOP 4:2:0, AAC ≤ 48 kHz 128 kbps,
23–60 fps, width ≤ 1920, VBR ≤ 25 Mbps, 9:16.

- **Professional account (Business or Creator) required** ([overview](https://developers.facebook.com/docs/instagram-platform/overview)).
- Instagram Login: `graph.instagram.com`, `instagram_business_basic` + `instagram_business_content_publish`, no Page needed. Facebook Login: `instagram_basic` + `instagram_content_publish` + `pages_read_engagement`, needs a Page ([content-publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing)).
- Standard Access covers accounts with a role on the app → single-owner app needs no App Review (inference).
- 100 API posts / 24 h (`content_publishing_limit`; carousel section says 50), 400 containers / 24 h.
- Stories (`media_type=STORIES`) for professional accounts — test on Creator; no link/poll/location stickers.
- Reels: `cover_url` (JPEG ≤ 8 MB, 9:16) or `thumb_offset` ms; `share_to_feed`; `audio_name` (rename once); `location_id`; `user_tags`; ≤ 3 collaborators; trial reels. Stories have no cover.
- Profile grid crops ~3:4 → keep cover content in the middle (3P: [Planoly](https://planoly.com/blog/guide-to-instagrams-new-vertical-grid)).
- Series: "Link a Reel" (Aug 2025, [TechCrunch](https://techcrunch.com/2025/08/21/instagram-now-lets-creators-link-multiple-reels-in-a-series/)) is app-only.
- Upload: public `video_url`, or `rupload.facebook.com` resumable (Facebook Login for Business only) ([resumable](https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads)).

## YouTube

- Short = vertical/square ≤ **3 min** (since 2024-10-15, [help](https://support.google.com/youtube/answer/15424877)); no API flag.
- `videos.insert`: own "Video Uploads" bucket, 100/day default ([ref](https://developers.google.com/youtube/v3/docs/videos/insert), [history](https://developers.google.com/youtube/v3/revision_history)).
- `thumbnails.set`: JPEG/PNG ≤ 50 MB, needs a phone-verified channel ([ref](https://developers.google.com/youtube/v3/docs/thumbnails/set), [9890437](https://support.google.com/youtube/answer/9890437)). Shorts custom thumbnails are app/Studio-only and rolling out ([blog](https://blog.youtube/news-and-events/youtube-studio-custom-thumbnail-updates/)) — assume no API.
- Series = playlist (`playlists.insert`, `playlistItems.insert`).
- OAuth consent screen in "Testing" → refresh tokens expire in 7 days; "In production" unverified works for personal use ([help](https://support.google.com/cloud/answer/15549945)).
- Unverified-project private lock: test with one upload; fix = [audit](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits).

## TikTok

Direct Post or upload-to-inbox; `FILE_UPLOAD` chunks 5–64 MB or `PULL_FROM_URL` (verified domain);
`video_cover_timestamp_ms`; ≤ 4 GB; duration cap from `creator_info.max_video_post_duration_sec`
([ref](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)). Unaudited apps:
`SELF_ONLY`, private account, ≤ 5 users/24 h. Mandatory preview / manual privacy / music consent UX
([guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)).

## Facebook Reels

Pages only; `POST /{page-id}/video_reels` via rupload; 3–90 s; 30 posts/24 h
([guide](https://developers.facebook.com/docs/video-api/guides/reels-publishing)).

## Telegram

`sendVideo` ≤ 50 MB via cloud Bot API, ≤ 2000 MB with a local Bot API server; `cover`,
`start_timestamp`, `thumbnail` (JPEG < 200 kB, ≤ 320 px) ([Bot API](https://core.telegram.org/bots/api)).
Size-limited, not duration-limited → no splitting.

## Series defaults

| Target | Max part | Why |
|---|---|---|
| IG Stories | 59 s | API cap 60 s |
| IG Reels | 179 s | reach drops > 3 min (API allows 15 min) |
| YT Shorts | 179 s | > 3 min = regular video |
| FB Reels | 89 s | API cap 90 s |
| TikTok | `creator_info` value, else 179 s | per creator |
| Telegram | no split | size-limited |

Creator convention: "1/3" / "Часть 1/3" for the first 2–3 s, top area inside the safe zone, plus
"(1/3)" in the caption; link parts in-app (IG) or by playlist (YT).

Integration order by friction: Telegram → YouTube → Instagram (Creator + Instagram Login + public URL) → Facebook (needs a Page) → TikTok (audit).
