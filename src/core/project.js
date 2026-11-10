import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

const FORMAT = 'openzoom-project';
const VERSION = 3;

/**
 * Project file (.ozp): a zip with the IFC files and project.json. Every part of
 * the app writes and reads its own section; older files are upgraded on reading.
 */
export function writeProject(app) {
  const M = app.models;
  const project = {
    format: FORMAT, version: VERSION, saved: new Date().toISOString(),
    // unique zip paths: two models may share a file name
    models: M.models.map((m, k) => ({ name: m.name, file: `models/${k + 1}_${m.name}`, visible: m.visible, state: app.state.serializeModel(m) })),
    state: app.state.serialize(),
    smartViews: app.smartViews.local,
    clashes: app.clashes.serialize(),
    issues: app.issues.serialize(),
    sections: app.sections.serialize(),
    camera: app.issues.captureCamera(),
  };
  const files = { 'project.json': strToU8(JSON.stringify(project)) };
  M.models.forEach((m, k) => { files[project.models[k].file] = [m.source, { level: 6 }]; });
  return zipSync(files);
}

/** Load a project file into an app without models. */
export async function readProject(app, file) {
  const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const project = upgrade(JSON.parse(strFromU8(z['project.json'])));
  for (const pm of project.models) {
    const data = z[pm.file];
    const model = data && await app.loadModel(new File([data], pm.name));
    if (!model) continue;
    model.visible = pm.visible !== false;
    app.state.restoreModel(model, pm.state);
  }
  app.smartViews.importSets(project.smartViews);
  app.clashes.load(project.clashes);
  app.issues.load(project.issues);
  app.state.load(project.state);
  app.sections.load(project.sections);
  if (project.camera) app.issues.applyCamera(project.camera);
}

/** Version 1 and 2 files in the current shape (version 1 kept its view as a BCF viewpoint). */
function upgrade(p) {
  if (p.version >= VERSION) return p;
  const view = p.view || {};
  return {
    models: (p.models || []).map((m) => ({ file: `models/${m.name}`, ...m })),
    state: { myView: p.myView || [], revealed: view.revealed || [view.showSpaces && 'spaces', view.showOpenings && 'openings'].filter(Boolean) },
    smartViews: p.smartViews || [],
    // clash results kept session ids (a, b) next to the GUIDs
    clashes: (p.clashTests || []).map((test) => ({ ...test, results: test.results.map(({ a, b, ...r }) => ({ refA: r.guidA, refB: r.guidB, ...r })) })),
    issues: p.issues || [],
    sections: view.sections || null,
    camera: view.camera || p.viewpoint?.camera || null,
  };
}
