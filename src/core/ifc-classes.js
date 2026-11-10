// IFC class helpers: display names, BIMcollab-style element type names used in
// .bcsv smart views and the component categories behind the Alt+<key> toggles.

const SPECIAL_ZOOM_TO_IFC = {
  'Building Story': ['IfcBuildingStorey'],
  'Building Element': ['IfcBuildingElement', 'IfcBuiltElement'],
  'Opening': ['IfcOpeningElement'],
  'Electric Flow Storage': ['IfcElectricFlowStorageDevice'],
  'Distribution Flow': ['IfcDistributionFlowElement'],
  'Point Cloud (PTS/XYZ/TXT)': [],
  'Point Clouds': [],
  'Point Cloud (E57)': [],
  'Scan': [],
  'PointCloud Part': [],
  'Other': [],
};

/** BIMcollab element type name ("Air Terminal Box") -> IFC class names. null = any. */
export function zoomTypeToClasses(name) {
  if (!name || name === 'Any') return null;
  if (SPECIAL_ZOOM_TO_IFC[name]) return SPECIAL_ZOOM_TO_IFC[name];
  return ['Ifc' + name.replace(/[^A-Za-z0-9]/g, '')];
}

/** IFC class -> BIMcollab element type name ("IfcAirTerminalBox" -> "Air Terminal Box"). */
export function classToZoomType(cls) {
  if (cls === 'IfcBuildingStorey') return 'Building Story';
  if (cls === 'IfcOpeningElement') return 'Opening';
  if (cls === 'IfcBuiltElement') return 'Building Element';
  return spaced(cls);
}

export function spaced(cls) {
  return (cls || '').replace(/^Ifc/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** Element types offered in the smart view editor (subset of the bcsv enum). */
export const ZOOM_TYPES = [
  'Any', 'Actuator', 'Air Terminal', 'Air Terminal Box', 'Alarm', 'Annotation', 'Assembly', 'Beam', 'Boiler', 'Building',
  'Building Element', 'Building Element Part', 'Building Element Proxy', 'Building Story', 'Cable Carrier Fitting',
  'Cable Carrier Segment', 'Cable Fitting', 'Cable Segment', 'Ceiling', 'Chimney', 'Civil Element', 'Column', 'Covering',
  'Curtain Wall', 'Damper', 'Discrete Accessory', 'Distribution Control Element', 'Distribution Element',
  'Distribution Flow Element', 'Distribution Port', 'Distribution System', 'Door', 'Duct Fitting', 'Duct Segment',
  'Duct Silencer', 'Electric Appliance', 'Electric Distribution Board', 'Element', 'Element Assembly', 'Energy Conversion Device',
  'Fan', 'Fastener', 'Feature Element', 'Filter', 'Fire Suppression Terminal', 'Flow Controller', 'Flow Fitting',
  'Flow Moving Device', 'Flow Segment', 'Flow Storage Device', 'Flow Terminal', 'Flow Treatment Device', 'Footing',
  'Furnishing Element', 'Furniture', 'Geographic Element', 'Grid', 'Group', 'Junction Box', 'Lamp', 'Light Fixture',
  'Mechanical Fastener', 'Member', 'Opening', 'Outlet', 'Pile', 'Pipe Fitting', 'Pipe Segment', 'Plate', 'Product', 'Project',
  'Proxy', 'Pump', 'Railing', 'Ramp', 'Ramp Flight', 'Reinforcing Bar', 'Reinforcing Element', 'Reinforcing Mesh', 'Roof',
  'Sanitary Terminal', 'Sensor', 'Shading Device', 'Site', 'Slab', 'Space', 'Space Heater', 'Spatial Element',
  'Spatial Structure Element', 'Spatial Zone', 'Stair', 'Stair Flight', 'Switching Device', 'System', 'Tank', 'Transport Element',
  'Unitary Equipment', 'Valve', 'Virtual Element', 'Wall', 'Wall Standard Case', 'Waste Terminal', 'Window', 'Zone',
];

const DE = {
  IfcProject: 'Projekt', IfcSite: 'Grundstück', IfcBuilding: 'Gebäude', IfcBuildingStorey: 'Geschoss', IfcSpace: 'Raum',
  IfcWall: 'Wand', IfcWallStandardCase: 'Wand', IfcCurtainWall: 'Vorhangfassade', IfcSlab: 'Decke/Platte', IfcRoof: 'Dach',
  IfcColumn: 'Stütze', IfcBeam: 'Träger', IfcDoor: 'Tür', IfcWindow: 'Fenster', IfcStair: 'Treppe', IfcStairFlight: 'Treppenlauf',
  IfcRamp: 'Rampe', IfcRampFlight: 'Rampenlauf', IfcRailing: 'Geländer', IfcCovering: 'Bekleidung', IfcPlate: 'Platte',
  IfcMember: 'Stab', IfcFooting: 'Fundament', IfcPile: 'Pfahl', IfcOpeningElement: 'Öffnung', IfcBuildingElementProxy: 'Proxy-Element',
  IfcFurnishingElement: 'Einrichtung', IfcFurniture: 'Möbel', IfcDuctSegment: 'Luftkanal', IfcDuctFitting: 'Kanalformteil',
  IfcPipeSegment: 'Rohr', IfcPipeFitting: 'Rohrformteil', IfcCableCarrierSegment: 'Kabeltrasse', IfcCableCarrierFitting: 'Trassenformteil',
  IfcAirTerminal: 'Luftauslass', IfcSanitaryTerminal: 'Sanitärobjekt', IfcLightFixture: 'Leuchte', IfcValve: 'Ventil',
  IfcPump: 'Pumpe', IfcFan: 'Ventilator', IfcFlowSegment: 'Leitung', IfcFlowFitting: 'Formteil', IfcFlowTerminal: 'Endgerät',
  IfcDistributionElement: 'Verteilelement', IfcElementAssembly: 'Baugruppe', IfcReinforcingBar: 'Bewehrungsstab',
  IfcTransportElement: 'Förderanlage', IfcGrid: 'Raster', IfcAnnotation: 'Annotation', IfcShadingDevice: 'Sonnenschutz',
  IfcChimney: 'Kamin', IfcBuildingElementPart: 'Bauteilschicht', IfcSpaceHeater: 'Heizkörper', IfcOutlet: 'Steckdose',
  IfcFlowController: 'Armatur', IfcEnergyConversionDevice: 'Energiewandler', IfcDistributionPort: 'Anschluss',
};

export function classLabel(cls, lang = 'de') {
  if (lang === 'de' && DE[cls]) return DE[cls];
  return spaced(cls);
}

// Component categories for the "Show/Hide components" menu (Alt+<key>).
// Gated categories (spaces, openings) stay hidden, also below a shown parent, until
// their Alt toggle reveals them or a smart view rule names their type, like in Zoom.
export const CATEGORIES = [
  { key: 'spaces', accel: 'S', classes: ['IfcSpace'], gated: true },
  { key: 'walls', accel: 'W', classes: ['IfcWall', 'IfcCurtainWall'] },
  { key: 'slabs', accel: 'L', classes: ['IfcSlab'] },
  { key: 'roofs', accel: 'R', classes: ['IfcRoof'] },
  { key: 'columns', accel: 'C', classes: ['IfcColumn'] },
  { key: 'beams', accel: 'B', classes: ['IfcBeam'] },
  { key: 'ceilings', accel: 'E', classes: ['IfcCovering'], predef: 'CEILING' },
  { key: 'stairs', accel: 'T', classes: ['IfcStair', 'IfcStairFlight', 'IfcRamp', 'IfcRampFlight'] },
  { key: 'doors', accel: 'D', classes: ['IfcDoor'] },
  { key: 'windows', accel: 'I', classes: ['IfcWindow'] },
  { key: 'openings', accel: 'O', classes: ['IfcFeatureElementSubtraction'], gated: true },
  { key: 'mep', accel: 'M', classes: ['IfcDistributionElement', 'IfcFlowSegment', 'IfcFlowFitting', 'IfcFlowTerminal', 'IfcFlowController', 'IfcEnergyConversionDevice', 'IfcFlowMovingDevice', 'IfcFlowStorageDevice', 'IfcFlowTreatmentDevice'] },
];

const GATED = new Map(CATEGORIES.filter((c) => c.gated).map((c) => [c.key, c]));

/**
 * Category key of an element, preferring the outermost aggregate it belongs to
 * (roof slab -> roofs). Spaces and openings keep their own category, and they
 * never pass theirs on (furniture in a space, an opening's host wall).
 */
export function categoryOf(el, ancestors = []) {
  const own = matchCategory(el.supers, el.predef);
  if (GATED.has(own)) return own;
  for (const a of ancestors) {
    const k = matchCategory(a.supers, a.predef);
    if (k && !GATED.has(k)) return k;
  }
  return own;
}

/** Element of a gated category (space, opening). */
export const isGated = (el) => GATED.has(el.category);

/**
 * True when one of `classes` names el's gated category or a subtype of it
 * ("Opening", "Space"), not merely a general class above it ("Element").
 * `supers` runs from the element's own class to the most general one.
 */
export function namesGatedType(el, classes) {
  const cat = GATED.get(el.category);
  if (!cat || !classes) return false;
  const root = Math.max(...cat.classes.map((c) => el.supers.indexOf(c)));
  return classes.some((c) => { const k = el.supers.indexOf(c); return k >= 0 && k <= root; });
}

function matchCategory(supers, predef) {
  for (const c of CATEGORIES) {
    if (c.classes.some((k) => supers.includes(k)) && (!c.predef || predef === c.predef)) return c.key;
  }
  return null;
}

/** Auxiliary objects: hidden when a model is loaded and by "show all", never clashed. */
const AUXILIARY = ['IfcVirtualElement', 'IfcAnnotation'];
export const isAuxiliary = (el) => AUXILIARY.some((c) => el.supers.includes(c));

export const SPATIAL = new Set(['IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcFacility', 'IfcFacilityPart', 'IfcBridge', 'IfcRoad', 'IfcRailway']);

/** Category color used for tree icons. */
export const CATEGORY_COLORS = {
  spaces: '#8fd18f', walls: '#b8b8b8', slabs: '#9e9e9e', roofs: '#a05a3c', columns: '#7b8fa6', beams: '#6c7f99',
  ceilings: '#d9d2c3', stairs: '#c4a26a', doors: '#a8743f', windows: '#6fb7e8', openings: '#e0e0e0', mep: '#e8a33c',
};
