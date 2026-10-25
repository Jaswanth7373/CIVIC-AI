/**
 * Icon registry: kebab-case icon names (as stored in the database, e.g. `Department.icon = "traffic-cone"`)
 * mapped to lucide-react components.
 *
 * Why a curated map instead of lucide's full icon index: importing every lucide icon would defeat
 * tree-shaking and add megabytes to the bundle. The map below contains the civic-relevant icons that admins
 * can pick (ICON_OPTIONS) plus every icon named in the default reference data, so any value saved through the
 * admin UI always resolves. Unknown names fall back to a neutral "help" icon instead of crashing.
 */
import { createElement, isValidElement } from 'react'
import {
  Accessibility,
  Activity,
  Ambulance,
  Biohazard,
  Bike,
  Bolt,
  Bug,
  Building,
  Building2,
  Bus,
  Cable,
  Car,
  CircleAlert,
  CircleDot,
  CircleHelp,
  CircleParking,
  CloudRain,
  Construction,
  Dog,
  Droplet,
  Droplets,
  Factory,
  Fence,
  FireExtinguisher,
  Flame,
  Flower2,
  Fuel,
  Hammer,
  HardHat,
  Hospital,
  House,
  Lamp,
  Landmark,
  Leaf,
  Lightbulb,
  Map as MapIcon,
  MapPin,
  Megaphone,
  Milestone,
  Mountain,
  Navigation,
  OctagonAlert,
  PaintBucket,
  ParkingMeter,
  PersonStanding,
  Plug,
  PlugZap,
  Power,
  Rat,
  Recycle,
  Route,
  School,
  ShieldAlert,
  ShieldCheck,
  ShowerHead,
  Shovel,
  Shrub,
  Signpost,
  Siren,
  Sprout,
  Store,
  Toilet,
  TrafficCone,
  Trash2,
  TrainFront,
  TreeDeciduous,
  TreePine,
  Trees,
  TriangleAlert,
  Truck,
  Umbrella,
  Waves,
  Wind,
  Wrench,
  Zap,
} from 'lucide-react'

/** kebab-case name -> lucide component. Includes every icon used by the default departments/categories. */
export const ICONS = Object.freeze({
  // Default reference data (BUILD_SPEC section 1)
  construction: Construction,
  'trash-2': Trash2,
  waves: Waves,
  lightbulb: Lightbulb,
  droplets: Droplets,
  'circle-dot': CircleDot,
  activity: Activity,
  'tree-deciduous': TreeDeciduous,
  'circle-help': CircleHelp,
  'traffic-cone': TrafficCone,
  recycle: Recycle,
  zap: Zap,
  trees: Trees,
  landmark: Landmark,
  'building-2': Building2,
  'circle-alert': CircleAlert,
  // Roads, traffic and transport
  route: Route,
  signpost: Signpost,
  milestone: Milestone,
  car: Car,
  bus: Bus,
  'train-front': TrainFront,
  bike: Bike,
  truck: Truck,
  'circle-parking': CircleParking,
  'parking-meter': ParkingMeter,
  navigation: Navigation,
  'map-pin': MapPin,
  map: MapIcon,
  // Works and maintenance
  hammer: Hammer,
  wrench: Wrench,
  'hard-hat': HardHat,
  shovel: Shovel,
  fence: Fence,
  'paint-bucket': PaintBucket,
  bolt: Bolt,
  // Electricity and lighting
  lamp: Lamp,
  plug: Plug,
  'plug-zap': PlugZap,
  power: Power,
  cable: Cable,
  // Water, drainage and weather
  droplet: Droplet,
  'shower-head': ShowerHead,
  toilet: Toilet,
  'cloud-rain': CloudRain,
  umbrella: Umbrella,
  wind: Wind,
  // Environment and parks
  leaf: Leaf,
  sprout: Sprout,
  shrub: Shrub,
  'tree-pine': TreePine,
  'flower-2': Flower2,
  mountain: Mountain,
  // Health, safety and hazards
  'triangle-alert': TriangleAlert,
  'octagon-alert': OctagonAlert,
  'shield-alert': ShieldAlert,
  'shield-check': ShieldCheck,
  siren: Siren,
  flame: Flame,
  'fire-extinguisher': FireExtinguisher,
  biohazard: Biohazard,
  ambulance: Ambulance,
  hospital: Hospital,
  bug: Bug,
  rat: Rat,
  dog: Dog,
  fuel: Fuel,
  // Places and public services
  building: Building,
  house: House,
  school: School,
  store: Store,
  factory: Factory,
  megaphone: Megaphone,
  accessibility: Accessibility,
  'person-standing': PersonStanding,
})

/** Older lucide names (and common variants) that may exist in saved data, mapped to current names. */
const ALIASES = {
  'alert-triangle': 'triangle-alert',
  'alert-circle': 'circle-alert',
  'help-circle': 'circle-help',
  'alert-octagon': 'octagon-alert',
  trash: 'trash-2',
  home: 'house',
  tree: 'tree-deciduous',
  'building-office': 'building-2',
  pothole: 'construction',
  garbage: 'trash-2',
  drainage: 'waves',
  streetlight: 'lightbulb',
  water: 'droplets',
}

/** Normalise "TrafficCone", "traffic_cone" or " Traffic-Cone " to "traffic-cone". */
export function normalizeIconName(name) {
  return String(name ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

/**
 * Resolve an icon name to a lucide component.
 * @param {string} name kebab-case name such as "traffic-cone"
 * @param {import('react').ComponentType} [fallback=CircleHelp] component used when the name is unknown
 */
export function getIcon(name, fallback = CircleHelp) {
  const key = normalizeIconName(name)
  return ICONS[key] ?? ICONS[ALIASES[key]] ?? fallback
}

/** "tree-deciduous" -> "Tree deciduous" (sentence case label for pickers). */
function humanize(name) {
  const text = name.replace(/-(\d+)$/, '').replace(/-/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Options for icon pickers in admin forms: `[{ value, label, Icon }]`, sorted by label. */
export const ICON_OPTIONS = Object.freeze(
  Object.entries(ICONS)
    .map(([value, Icon]) => ({ value, label: humanize(value), Icon }))
    .sort((a, b) => a.label.localeCompare(b.label)),
)

/**
 * Render an icon given either a component (`MapPin`), an element (`<MapPin />`) or a kebab-case name.
 * Icons are decorative by default (`aria-hidden`), because the surrounding control carries the label.
 */
export function renderIcon(icon, props = {}) {
  if (!icon) return null
  if (isValidElement(icon)) return icon
  const Component = typeof icon === 'string' ? getIcon(icon) : icon
  return createElement(Component, { 'aria-hidden': true, focusable: 'false', ...props })
}
