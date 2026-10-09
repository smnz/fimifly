# Reconstruction with OpenDroneMap

From the editor: open any route of the grid, attach each route's photos, and
press **Build orthophoto** in the photo panel. It takes every route of the
chain (the routes linked by Next route, both ways), stages their photos and
runs `run.sh` below in the background, in a new folder named after the grid
(`odm/grid-1oct-0930`, say). When it is done the orthophoto can be laid over
the map (Show on map); the files are those listed under 4.

By hand:

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

## Keep `grid27sep/` — it is the Property Map reference

The Erewhon app's Property Map (`erewhon/scripts/make_ortho_tiles.sh`) registers
every new orthophoto to `odm/grid27sep/odm_orthophoto/odm_orthophoto.tif`, the
2026-09-27 survey that the pipes, cables and soil grid are drawn on. Don't
delete or move it; if it must move, update `source` in
`erewhon/website/info/property-map/tiles/2026-09-27/meta.json` to match.
