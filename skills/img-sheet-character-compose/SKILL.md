---
name: img-sheet-character-compose
description: Create a realistic 16:9 character reference sheet that preserves the primary image's identity, pose, and body language while using later references only to recover missing details. Use only when the user explicitly invokes `$img-sheet-character-compose` or directly asks to use this named skill; never auto-select it from a generic character or image request.
---

# Character Sheet Compose

Use the available image-generation capability directly. Create the requested image rather than returning only a text prompt unless the user explicitly asks for prompt text.

Create a realistic **16:9 character reference sheet** from the provided images.

Use the **first image as the absolute primary reference**. Preserve its exact identity, expression, gaze, hairstyle, body proportions, outfit, materials, colors, accessories, and especially its **pose, posture, weight distribution, gesture, and natural body language**.

Use all other images only to **recover and complete details missing from the first image**: cropped limbs, full outfit, shoes, side/back construction, hair, accessories, tattoos, scars, and other obscured features. They must never override clearly visible details from the primary image.

Create consistent turnarounds that show **the same character translated from the original pose and physical attitude**, not reset into a generic neutral mannequin stance. Infer how the original posture, limb placement, torso angle, balance, and clothing naturally continue when viewed from each direction.

**Layout:** four large full-body views — **front, left profile, right profile, back** — plus stacked **front, ¾ left, ¾ right portraits**. Full-body views must be complete head-to-toe, anatomically correct, consistent in scale and detail, with no overlap or cropping.

Match the primary image's realism, textures, lighting, and rendering.

Background: uninterrupted solid `#EAE7DC`. No text, labels, borders, guides, grids, scenery, shadows, logos, or watermarks.

**Priority:** primary pose and identity fidelity → recover hidden original details → consistent turnaround reconstruction → orthographic readability.
