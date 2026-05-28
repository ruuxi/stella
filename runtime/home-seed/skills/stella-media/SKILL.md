---
name: stella-media
description: Generate images, video, audio, and 3D through Stella's managed media gateway. Use when the user asks for any generated media. Don't call provider APIs directly — the gateway handles auth, billing, and persistence centrally.
---

# Generating media via Stella

Stella ships a managed media gateway that fronts every supported provider. Use it instead of calling provider APIs directly.

## Still images

General does not call `image_gen` directly. For still images, read the image docs below and route through Stella's managed media gateway. The sidebar surfaces generated assets automatically — tell the user **what** you generated, not where it is. A one-liner like "Generated a 16:9 still of the Tokyo alley scene" is enough.

## Video, audio, 3D — read the relevant doc page first

`web` fetch the URL for the operation you need, then call the gateway accordingly:

| Domain   | URL                                   | Operations                                                                     |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| Overview | `https://stella.sh/docs/media`        | Request/response shape, auth contract                                          |
| Images   | `https://stella.sh/docs/media/images` | `text_to_image`, `icon`, `image_edit`                                          |
| Video    | `https://stella.sh/docs/media/video`  | `image_to_video`, `video_extend`, `video_to_video`                             |
| Audio    | `https://stella.sh/docs/media/audio`  | `text_to_dialogue`, `sound_effects`, `speech_to_text`, `audio_visual_separate` |
| Music    | `https://stella.sh/docs/media/music`  | `text_to_music`                                                                |
| 3D       | `https://stella.sh/docs/media/3d`     | `text_to_3d`                                                                   |

Examples/references: `desktop/src/app/media/MediaStudio.tsx` and `desktop/src/features/music/services/lyria-music.ts`.

## Don't call provider APIs directly

Unless the task explicitly requires something the gateway doesn't support, route through the gateway. Direct provider calls bypass billing, auth, and persistence.

## 401 means the user is signed out

The 401 body has `code: "auth_required"` and an `action` string. Stop the job, surface `action` to the user verbatim via the Orchestrator, and retry once they confirm sign-in. Don't loop.

## Backlinks

- [Skills Index](../index.md)
- [general-agent](../../../runtime/extensions/stella-runtime/agents/general.md)
