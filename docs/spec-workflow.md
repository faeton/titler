# Titler — target workflow spec (owner's brief, 2026-10-24)

The owner's brief, translated from Russian (the original is in git history before 2026-10-27).
This is the target the redesign works toward; nothing here is implemented yet unless the code says so.

This is the spec for the reworked workflow: upload video from the glasses, choose natural and intelligible sound, quickly fix the transcript, prepare the frame and captions, then publish separate versions to the right social networks. The main product quality metric is how much manual work is left between uploading a clip and a finished publication.

Language priority: about 90% Russian, plus mixed Russian-Ukrainian speech and English. Project: [faeton/titler](https://github.com/faeton/titler). Comfortable work from a phone is required. Below is how the existing Titler evolves; the proposed features should not be treated as already implemented.

# User workflow

Upload → compare sound → recognise → review disputed spots → edit words and timings → framing and styling → review separate publications.

After upload the user immediately sees a video preview and the processing state. Work can continue after the tab is closed. The source is kept unchanged; every result is tied to a project version. Processing a long clip must not block listening to a fragment that is already ready.

# Voice choice

First the system prepares short comparable fragments: normal speech, a hard section with wind or traffic and, if present, a section with other people's voices. The user can also pick any segment of their own.

On the same segment the source and three starting variants are available: gentle cleanup that keeps the surroundings, a more pronounced voice, strong background suppression. These are presets within which voice level and residual background can be adjusted. Separate toggles enable hum removal or loudness levelling. All variants are compared at comparable perceived loudness: a louder variant must not win just because it is louder.

Switching A/B/C keeps the playback position. There is looping, a quick return to the source and a "use for the whole clip" mark. A hard section can have its own preset; the joins need a smooth transition.

Boosting all speech and isolating the owner's voice specifically are different tasks. If other speakers need to be suppressed, a separate target-speaker mode is needed. The user marks a clean fragment of their voice; if its quality is insufficient, the system asks for another fragment or falls back to normal cleanup. Automatically removing other people's lines from a dialogue is not allowed.

To keep the surroundings, separate time-aligned speech and background tracks are preferable. Simply mixing processed speech with the source can double the voice and cause phase artifacts. If there is no reliable separation, the interface controls cleanup strength without promising independent background control.

Processing must not change duration or sync with the video. Model latency compensation is mandatory. Strong suppression can damage consonants; speech that is missing from the recording cannot be reliably restored. Synthesising a new voice is not part of the base workflow.

# Recognition and choosing variants

The sound the user chose becomes the main listening track. For recognition the system may compare it with the source or the gently cleaned track: the most pleasant sound doesn't necessarily give the fewest ASR errors.

The first pass produces text, preliminary timings and review candidates. A second independent recogniser processes the whole short clip or the disputed sections of a long one. Running all models on all sound variants by default should be avoided: it increases latency and cost with no guaranteed benefit.

For each disputed range the model variants, the source of each variant and the audio processing applied are stored. Alternatives can span several words: one model hears one word, another two. Equal token counts must not be assumed.

The user sees clear review reasons: "models heard it differently", "speech without text", "doubtful boundary", "name from the dictionary". Numeric confidences of different models are not compared directly. Models agreeing doesn't guarantee correctness.

A built-in dictionary supports names, Awerti, Esports Charts, Streams Charts, place names and other user terms. The system suggests spellings but doesn't substitute these words into every unclear spot.

A language-model review proposes contextual fixes separately from acoustic hypotheses. A "by meaning" suggestion is explicitly marked. Words the user approved are not rewritten automatically. Mixed Russian-Ukrainian speech is kept as spoken; translating into one language is a separate operation.

# Text and playback editor

The main area shows readable phrases and paragraphs. Every word is linked to audio, but the text must not look like a hundred separate buttons. During playback the current word is highlighted. Auto-scroll pauses while the user reads or edits another section.

On the phone a compact video is at the top, the text below, playback and contextual actions pinned at the bottom. When the keyboard opens the video shrinks and the edited line stays visible. Buttons need large enough touch targets; for short words there is expanded context.

| Action | Phone | Desktop |
| - | - | - |
| Select a word | One tap selects the word and sets the playback position | Click in view mode |
| Listen to context | A button next to the selected word, a short loop with neighbouring words | Play key outside typing mode |
| Fix a word | A second tap or an explicit "Edit" button opens the keyboard | Enter or switching to edit mode |
| Pick a suggestion | Bottom panel with variants and their sources | Panel and arrow keys |
| Select a range | Long press opens selection and a menu | Shift and movement keys |
| Insert a missing word | "Insert before/after" or selecting a range on the audio track | Normal typing at the cursor |
| Change timing | A separate mode with large boundary handles | Dragging boundaries and fine adjustment |
| Undo | An always-available button | Cmd/Ctrl+Z, redo |

A single tap doesn't start unexpected autoplay. A long press doesn't delete or move a word by itself. Delete, replace and merge are explicit and undone with one action.

Editing supports a normal keyboard: cursor, selection, text insertion, Backspace, Delete, Enter, inserting several words and replacing a whole range. While typing, space types a space. Player hotkeys don't intercept text input or mobile keyboard composition.

Two clearly distinct operations are needed: "remove from captions" and "cut from the video". A normal text fix changes only the transcript. Text-based editing, if added, works as a separate mode with a preview of the result.

Quick review jumps between disputed spots instead of making the user reread the whole clip. After a fix the range can be marked reviewed and the next one opened.

# Missing words and exact timings

Every text unit has a stable ID, a start and end in the source recording, a text source, recognition variants, a user review status and a separate timing status: preliminary, aligned or set by hand. Punctuation doesn't need its own audio interval.

Insertion scenario: the system recognised «я приехал Самоа» ("I arrived Samoa") and the recording has «я приехал на Самоа» ("I arrived in Samoa"). The user puts the cursor between the words, types «на», then the system re-aligns a small phrase with the neighbouring words. It may slightly change neighbouring boundaries without touching confirmed manual anchors.

If a word is missed entirely, the user expands the waveform, listens to the section, selects a range and taps "Add word". The waveform can be zoomed; playback of the selection loops. An extra spectral view is useful for hard cases but isn't needed in the main interface.

The waveform shows energy, not ready word boundaries. Speech region marks serve as guidance. The absence of a free gap between neighbouring words doesn't forbid insertion: the previous boundaries may have been wrong.

When acoustic alignment succeeds, the word gets a new interval. When it fails, the word stays marked "timing not confirmed" with manual adjustment available. Distributing time by word length is acceptable only as a temporary approximation.

On merge, split, multi-word insertion and language edits the local phrase is re-aligned. Changing a comma doesn't trigger processing of the whole clip. Re-running ASR keeps confirmed edits and manual boundaries.

After editing cuts there is a separate map between source and export time. Words, captions and framing use this map so that editing doesn't break sync.

# Framing and captions

Formats: 9:16, 16:9 and the source aspect ratio. Each offers fill with cropping and fit with margins or a background. The user sees exactly what will be lost.

Automatic framing proposes a region of interest, but manual offset and time keyframes are always available. In POV video the author's face is usually not the subject; the crop must not be built around a face unconditionally.

The preview accounts for the chosen platform and its interface zones. The transcript is stored separately from caption styling: changing font, line breaks and size doesn't change the text or word timings. Phrase captions are supported and, optionally, highlighting of the current word.

Export includes video with the chosen audio track, a version with burned-in captions, a clean version and SRT/VTT when needed. The final video is checked for sync, cut-off lines and text going outside the frame.

# Model candidates

This is a set for a comparative test, not an announced winner.

| Task | Starting candidate | Selection criteria |
| - | - | - |
| Gentle cleanup | DeepFilterNet | Full-band processing; check wind, quiet consonants and latency |
| Stronger cleanup | FRCRN or MossFormer from ClearerVoice-Studio | Compare artifacts and timbre preservation; evaluate enhancement and speaker isolation separately |
| Base RU/UA/EN recognition | Whisper large-v3 | Test on real language mixing; don't force the whole file to Russian |
| Independent cloud recognition | ElevenLabs Scribe v2 | Claims multilingual support, word timings and term hints; audio has to be sent to the provider |
| Additional local Russian candidate | GigaAM-v3 | A Salute/Sber project; use only if the provenance is acceptable. Running locally doesn't send the recording to this provider |
| Boundary refinement | WhisperX and language aligner models | After fixing the text; mixed speech, numbers and overlapping voices need separate checks |

[DeepFilterNet](https://github.com/Rikorose/DeepFilterNet), [ClearerVoice-Studio](https://github.com/modelscope/ClearerVoice-Studio), [Whisper](https://github.com/openai/whisper), [Scribe](https://elevenlabs.io/docs/overview/capabilities/speech-to-text), [GigaAM](https://github.com/salute-developers/GigaAM), [WhisperX and limitations](https://github.com/m-bain/whisperX).

For the first comparison it's reasonable to take Whisper and Scribe as independent hypotheses, then assess the value of a local Russian candidate. Check the licences of the specific weights and their fit for the chosen deployment mode before including them in the product. Cost and hardware are chosen after measuring on test clips.

# Publishing and audience

Provide two ways to finish the workflow: direct publishing via API and a prepared export for finishing the publication in the native app. For the second, first check that file handoff is supported on the device; the fallback is to download the video and copy the caption. Handing off to the app doesn't mean the publication happened.

| Destination | Path | Audience choice |
| - | - | - |
| Instagram Reels and posts | API for a professional Business or Creator account | Don't promise Close Friends via the API; for a restricted audience finish in Instagram |
| Instagram Stories | A separate check of the account type and available API | In the Facebook Login docs Stories are limited to Business; check other connection paths before enabling |
| Facebook Page Reels | Page publishing API | Page publications are publicly visible |
| Personal Facebook profile | Export and finish in Facebook | The user picks friends, a restricted list or another available audience in Facebook |
| Telegram channel or group | Bot API sendVideo with the required rights | The audience of the chosen channel or group; a private channel is chosen separately |
| Telegram Stories | A separate integration stage | Bot API postStory for a managed business account; more flexible privacy_rules are available in MTProto stories.sendStory |

For Telegram, forwarding protection via protect_content doesn't replace audience choice. In a channel the bot must have the right to post. Telegram Stories should not be mixed with ordinary video posting to a channel: it's a separate workflow and authorisation.

The pre-send screen shows, per platform, the account, format, exact audience, caption, cover and final video version. If the required audience is unavailable, publishing is blocked or switched to manual completion. Silently falling back to public publishing is forbidden.

Meta needs an app, a suitable Login flow, permissions and tokens. Connecting third-party clients requires the corresponding Advanced Access and App Review. A prototype for one's own accounts and a public service have different requirements. Don't hard-code a mandatory Facebook Page link for all Instagram login methods: it depends on the chosen API.

Each platform gets a separate job and state: prepared, uploading, processing, published, error or finished in the app. Store remote object IDs, reconcile state after a timeout and don't duplicate an already successful publication on retry. An error on one platform doesn't roll back a successful one on another.

The matrix is based on official documentation checked on 24 October 2026. Some Meta pages couldn't be read in full; scope and permission details were filled in from indexed fragments of official docs. Stories for a specific login method and Close Friends are not to be treated as confirmed features until checked on the connected account.

# Titler architecture

We develop the existing Titler: Studio on Vite, React and TypeScript; a server on Fastify and TypeScript; Remotion Player for preview; ffmpeg and ASS for rendering. scripts/transcribe.py already has Whisper large-v3 via mlx-whisper and faster-whisper with word timings, language setting and initial prompt. Keep this base and add a processed-audio selection step, independent recognition hypotheses and local timing refinement.

studio/src/components/TranscriptEditor.tsx already has jump-to-word, inline editing by double click, delete on hover and insertion through a narrow gap between words. These mechanics need reworking for touch and full keyboard editing: an explicit action panel, comfortable touch targets, insert before and after a word, range editing and working with the waveform. Additional ASR results must be stored separately from user-confirmed text; the current transcript update when recognition finishes needs protection for manual edits.

Each stage is cached by source, parameters and model version. Changing the crop doesn't recompute the voice; editing a word doesn't redo audio cleanup. A background job records the result version, and the interface applies it only to a compatible text version. A late model response must not overwrite a fresh manual edit.

# Quality checks and development order

First collect a small labelled set of real recordings from the glasses: calm speech, street, wind, traffic, other voices, Russian, mixed speech and English. Split examples into a tuning set and an independent test set. Without this, choosing "the best model" is a guess.

Measure voice intelligibility and naturalness in a blind comparison, recognition errors and separately name and language-switch errors, word boundary deviations, manual finishing time per minute of clip, processing latency and cost. Evaluate user sound preference and ASR accuracy separately.

First working loop: upload, source and two cleanup variants, comparison, main ASR, keyboard editing, word insertion with local alignment, 9:16 and export. Next stage: second ASR, hypothesis reconciliation, dictionary, disputed-spot review mode, improved framing. Then connect publishing according to confirmed account capabilities.

Critical checks: a word from the audio is added without damaging the neighbouring phrase; a word that isn't in the audio doesn't get a false exact-alignment status; an edit survives a page reload and an ASR re-run; the mobile keyboard doesn't cover the edited spot; deleting text doesn't cut the video; no platform gets a wider audience because of an error or a repeated request.
