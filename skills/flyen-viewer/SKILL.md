---
name: flyen-viewer
description: Look at, navigate and measure a medical imaging study (CT, MRI, X-ray) that is open in the Flyen DICOM Viewer on this computer, using the Flyen tools. Use when the user asks about the study on their screen in Flyen, wants Claude to find or show something in it, measure density or size, or run / show AI organ segmentation.
---

# Working with a study open in Flyen

Flyen is a DICOM viewer running on the user's own computer. The Flyen tools
read what it shows and change the view; they never return the patient's name,
ID, birth date, institution or file paths.

## Before anything

1. Call `get_state` first. It tells you the view mode (2d / mpr / 3d), the
   series of the study, the current slice and window, and the AI segmentation
   state. If it fails, tell the user to open Flyen and switch on
   **AI → Allow Claude Desktop to control Flyen**.
2. Look with `get_view_image` before describing anything. Never describe an
   image you have not fetched.

## Finding and showing things

- Pick the series that fits the question (`select_series`; e.g. contrast
  phase for vessels, thin slices for nodules) and a suitable window
  (`set_window`: Lung, Bone, Soft Tissue, Brain, Liver …).
- Move through the study with `set_slice` (absolute `index` or relative
  `step`). In MPR, `set_mpr_point` puts the crosshair on a finding so the other
  two planes pass through it.
- Points are fractions (0…1) of one plane image. Before measuring, check your
  points with `get_view_image` `marks`; use `grid` or `region` for small
  findings.
- `measure_hu` (density) and `measure_distance` (size) give numbers; report
  them with their units and the slice / plane you measured on.
- To show the user where to look, use `annotate` (arrow with a short label)
  and `set_zoom`; remove your marks with `clear_annotations` when done.
- `set_slab` gives MIP (vessels, nodules) or MinIP (airways, emphysema).

## AI organ segmentation

- `segmentation_show` shows or hides structures in 2D, MPR and 3D together;
  `segmentation_stats` gives their volume and density.
- `segmentation_run` runs for several minutes on the user's computer. Ask the
  user before starting it, say roughly how long it takes, and poll
  `get_state` → `ai_segmentation.running` instead of waiting silently.

## How to report

- These tools are for viewing support, **not for diagnosis**. Describe what
  you see and measure, say how certain you are, and recommend that a
  qualified physician (radiologist) reviews the study and makes any clinical
  decision. Say this plainly in every answer about findings.
- Do not repeat names or other identifiers you might read in text burned into
  the image pixels.
- Only open other studies (`list_studies`, `open_study`) when the user asks.
