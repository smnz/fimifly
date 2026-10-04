# Reconstruction with OpenDroneMap

1. Attach the flight's photos to their routes in the editor (or keep them in a folder).
2. Stage them: `./odm/stage.py flight1 --like '%grid 13Sep%'` (route name pattern),
   `./odm/stage.py flight1 --routes 10 11 12`, or `./odm/stage.py flight1 --dir <folder> --newest 60`.
   Copies get the lens EXIF the Fimi leaves blank (4.71 mm, 27 mm equivalent).
3. Run: `./odm/run.sh flight1`. First run downloads nothing further; expect roughly a
   minute per ten photos on the GPU build at these settings.
4. Results in `odm/flight1/`: `odm_orthophoto/odm_orthophoto.tif` and `.kmz` (drop the
   KMZ on Google Earth), `odm_dem/dsm.tif`, the point cloud under `odm_georeferencing/`,
   the textured mesh under `odm_texturing/`, and the refined camera under
   `cameras.json` / `opensfm/camera_models.json`.

Useful extras: `--dtm` for a bare-earth model, `--pc-quality high` for a denser cloud,
`--fast-orthophoto` for a quick look without the mesh, `--rerun-all` to start over.
Project folders are ignored by git; only these scripts are tracked.
