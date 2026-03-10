---
id: media-generation
name: Media Generation
description: Generate or edit images and videos from text prompts using AI models.
agentTypes:
  - general
tags:
  - media
  - images
  - video
  - generation
version: 1
---

# Media Generation

Generate or edit images and videos from text prompts.

## MediaGenerate Parameters
- `mode`: `"generate"` to create from scratch or `"edit"` to modify existing media
- `media_type`: `"image"` or `"video"`
- `prompt`: detailed description of what to create or how to edit
- `source_url`: required for edit mode, the URL of the source image or video

## Examples

Generate an image:

```
MediaGenerate(mode="generate", media_type="image", prompt="A serene mountain landscape at sunset with warm orange and purple tones")
```

Edit an existing image:

```
MediaGenerate(mode="edit", media_type="image", prompt="Make the sky more dramatic with storm clouds", source_url="https://...")
```

## Tips
- Be specific and descriptive in prompts for better results.
- Mention style, mood, composition, and color palette when relevant.
- For edits, describe the desired change clearly.
