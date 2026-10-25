"""Default reference data for CivicAI and the idempotent functions that install it.

Installed by ``python manage.py init_civicai`` (see management/commands/init_civicai.py):

* 7 municipal departments and 9 civic issue categories exactly as listed in docs/BUILD_SPEC.md section 1.
  The category slugs equal the AI engine's class names (``ai.config.CIVIC_CLASSES``). Keywords mix
  English, Indian English and common romanised Hindi / Telugu words (gaddha, kachra, chetta, nala, bijli,
  paani, neeru, chettu ...) because citizens describe problems that way; the NLP classifier blends these
  DB keywords into its scores, and ``vision_labels`` map detector class names onto categories.
* The AIConfiguration singleton (created with the model defaults if it does not exist yet; an admin's
  tuned weights are never overwritten).
* Hyderabad risk zones: well-known public hospitals, markets, schools/universities, railway and metro
  stations and major junctions, with risk level 3-5 and radius 200-500 m. They feed the location-risk
  factor of severity and priority. Coordinates are approximate landmark positions taken from
  OpenStreetMap (Nominatim search, data (c) OpenStreetMap contributors, ODbL).

Every ``ensure_*`` function is idempotent: rows are matched on a natural key (department ``code``, category
``slug``, risk-zone ``name``) and updated in place with ``update_or_create``, so running the command twice
never duplicates anything. ``update_existing=False`` only creates missing rows and leaves admin edits alone -
except that a department's *empty* contact fields (e-mail, phone, head) are filled in, so installations created
before the defaults had contacts get them too.

The department contacts are fictitious placeholders for the demo: ``.local`` e-mail addresses (a reserved,
non-routable domain) and phone numbers in the unassigned ``0000`` exchange. Replace them with the real municipal
contacts on the Departments page before going live.
"""
from django.db import transaction

from apps.core.models import AIConfiguration, RiskZone

from .models import CivicCategory, Department


class ReferenceDataError(Exception):
    """Raised when existing data conflicts with the defaults (e.g. a department name used by another code)."""


#: Contact fields of a department that ``ensure_departments(update_existing=False)`` fills in when they are empty.
CONTACT_FIELDS = ("email", "phone", "head_name")

DEFAULT_DEPARTMENTS = [
    {
        "code": "ROADS", "name": "Roads Department", "icon": "traffic-cone", "color": "#D9480F", "sla_hours": 72,
        "description": "Road surfaces, potholes, cracks and carriageway damage, open manholes on roads and "
                       "footpath repairs.",
        "email": "roads@civicai.local", "phone": "+91 40 0000 0101", "head_name": "Er. K. Venkat Rao",
    },
    {
        "code": "WASTE", "name": "Waste Management", "icon": "recycle", "color": "#9C6B30", "sla_hours": 48,
        "description": "Garbage collection, overflowing bins, illegal dumping and street sweeping.",
        "email": "waste@civicai.local", "phone": "+91 40 0000 0102", "head_name": "Smt. S. Lakshmi Devi",
    },
    {
        "code": "DRAIN", "name": "Drainage Department", "icon": "waves", "color": "#0B8EA8", "sla_hours": 48,
        "description": "Storm-water drains, sewage overflow, blocked nalas and waterlogged streets.",
        "email": "drainage@civicai.local", "phone": "+91 40 0000 0103", "head_name": "Er. M. Prakash Reddy",
    },
    {
        "code": "ELEC", "name": "Electrical Department", "icon": "zap", "color": "#E0A800", "sla_hours": 48,
        "description": "Streetlights, exposed or hanging electric wires and other public electrical fixtures.",
        "email": "electrical@civicai.local", "phone": "+91 40 0000 0104", "head_name": "Er. A. Srinivas",
    },
    {
        "code": "WATER", "name": "Water Supply", "icon": "droplets", "color": "#3B5BDB", "sla_hours": 24,
        "description": "Drinking-water supply, pipeline leaks and bursts, contaminated or wasted water.",
        "email": "water@civicai.local", "phone": "+91 40 0000 0105", "head_name": "Er. P. Anuradha",
    },
    {
        "code": "PARKS", "name": "Parks & Public Works", "icon": "trees", "color": "#2F9E44", "sla_hours": 48,
        "description": "Fallen or dangerous trees, road obstructions, parks and public open spaces.",
        "email": "parks@civicai.local", "phone": "+91 40 0000 0106", "head_name": "Sri. R. Naresh Kumar",
    },
    {
        "code": "GEN", "name": "General Civic Department", "icon": "landmark", "color": "#6B7C85", "sla_hours": 96,
        "description": "Civic issues that do not belong to a specialised department; triage and re-routing.",
        "email": "civic.help@civicai.local", "phone": "+91 40 0000 0100", "head_name": "Smt. V. Kavitha",
    },
]

DEFAULT_CATEGORIES = [
    {
        "slug": "pothole", "name": "Roads / Potholes", "icon": "construction", "color": "#D9480F",
        "department": "ROADS", "secondary_department": None, "base_severity": 60, "public_safety_weight": 0.75,
        "sla_hours": None, "sort_order": 10,
        "description": "Potholes, craters and holes in the road surface that endanger vehicles and pedestrians.",
        "keywords": ["pothole", "potholes", "pit", "crater", "hole in road", "road hole", "broken road", "gaddha",
                     "gadda", "khadda", "gunta", "guntalu"],
        "vision_labels": ["pothole", "road_hole"],
    },
    {
        "slug": "garbage", "name": "Garbage / Waste", "icon": "trash-2", "color": "#9C6B30",
        "department": "WASTE", "secondary_department": None, "base_severity": 40, "public_safety_weight": 0.45,
        "sla_hours": None, "sort_order": 20,
        "description": "Uncollected garbage, overflowing bins, litter and illegal dumping of waste.",
        "keywords": ["garbage", "trash", "waste", "dump", "dumping", "rubbish", "litter", "dustbin",
                     "overflowing bin", "kachra", "kooda", "chetta", "chetha"],
        "vision_labels": ["garbage", "trash", "litter", "waste_pile"],
    },
    {
        "slug": "drainage", "name": "Drainage / Waterlogging", "icon": "waves", "color": "#0B8EA8",
        "department": "DRAIN", "secondary_department": None, "base_severity": 55, "public_safety_weight": 0.60,
        "sla_hours": None, "sort_order": 30,
        "description": "Blocked or overflowing drains, sewage on the street and waterlogged or flooded roads.",
        "keywords": ["drain", "drainage", "sewage", "sewer", "waterlogging", "water logging", "flooded",
                     "flooding", "overflow", "clogged drain", "blocked drain", "gutter", "stagnant water", "nala",
                     "nallah", "murugu neeru"],
        "vision_labels": ["drainage", "waterlogging", "flooded_road", "sewage_overflow"],
    },
    {
        "slug": "streetlight", "name": "Streetlight / Electricity", "icon": "lightbulb", "color": "#E0A800",
        "department": "ELEC", "secondary_department": None, "base_severity": 45, "public_safety_weight": 0.60,
        "sla_hours": None, "sort_order": 40,
        "description": "Streetlights that are off or damaged, dark stretches of road and hanging electric wires.",
        "keywords": ["streetlight", "street light", "light not working", "no light", "dark", "darkness", "pole",
                     "lamp post", "bulb", "electric wire", "hanging wire", "power cut", "current", "bijli",
                     "karent", "light ledu"],
        "vision_labels": ["streetlight", "street_light", "lamp_post", "broken_streetlight"],
    },
    {
        "slug": "water_leak", "name": "Water Supply / Water Leakage", "icon": "droplets", "color": "#3B5BDB",
        "department": "WATER", "secondary_department": None, "base_severity": 50, "public_safety_weight": 0.40,
        "sla_hours": None, "sort_order": 50,
        "description": "Leaking or burst water pipelines, wasted drinking water and water-supply failures.",
        "keywords": ["leak", "leakage", "water leak", "pipeline", "pipe burst", "burst", "water wastage",
                     "water supply", "no water", "tap", "valve", "contaminated water", "paani", "pani", "neeru",
                     "neellu"],
        "vision_labels": ["water_leak", "pipe_leak", "burst_pipe"],
    },
    {
        "slug": "open_manhole", "name": "Open Manhole", "icon": "circle-dot", "color": "#C92A2A",
        "department": "ROADS", "secondary_department": "DRAIN", "base_severity": 85, "public_safety_weight": 0.95,
        "sla_hours": 12, "sort_order": 60,
        "description": "Uncovered manholes or drain chambers with missing or broken lids - a severe fall hazard.",
        "keywords": ["manhole", "open manhole", "manhole cover", "open drain cover", "uncovered", "missing lid",
                     "broken lid", "chamber"],
        "vision_labels": ["open_manhole", "manhole", "uncovered_manhole"],
    },
    {
        "slug": "road_crack", "name": "Road Cracks / Road Damage", "icon": "activity", "color": "#9C36B5",
        "department": "ROADS", "secondary_department": None, "base_severity": 40, "public_safety_weight": 0.50,
        "sla_hours": None, "sort_order": 70,
        "description": "Cracked, uneven or crumbling asphalt and other damage to the road surface.",
        "keywords": ["crack", "cracks", "cracked road", "damaged road", "road damage", "uneven", "uneven road",
                     "broken asphalt", "surface damage", "tar damaged"],
        "vision_labels": ["road_crack", "crack", "road_damage", "alligator_crack"],
    },
    {
        "slug": "fallen_tree", "name": "Fallen Tree / Obstruction", "icon": "tree-deciduous", "color": "#2F9E44",
        "department": "PARKS", "secondary_department": None, "base_severity": 65, "public_safety_weight": 0.80,
        "sla_hours": 24, "sort_order": 80,
        "description": "Fallen or uprooted trees, broken branches and other obstructions blocking a road or path.",
        "keywords": ["tree", "fallen tree", "tree fell", "branch", "branches", "fallen", "uprooted", "obstruction",
                     "blocked road", "chettu", "chettu padindi", "ped"],
        "vision_labels": ["fallen_tree", "fallen_branch", "uprooted_tree", "tree"],
    },
    {
        "slug": "other", "name": "Other", "icon": "circle-help", "color": "#6B7C85",
        "department": "GEN", "secondary_department": None, "base_severity": 30, "public_safety_weight": 0.30,
        "sla_hours": None, "sort_order": 90,
        "description": "Any other civic issue, for example encroachments, stray animals or damaged public property.",
        "keywords": ["encroachment", "stray dogs", "stray cattle", "illegal construction", "noise",
                     "public nuisance", "damaged public property"],
        "vision_labels": ["other"],
    },
]

# Well-known public landmarks in Hyderabad; WGS84 positions from OpenStreetMap / Nominatim (approximate).
DEFAULT_RISK_ZONES = [
    {"name": "Osmania General Hospital, Afzal Gunj", "zone_type": RiskZone.ZoneType.HOSPITAL,
     "latitude": "17.372954", "longitude": "78.474270", "radius_m": 300, "risk_level": 5,
     "description": "Major government hospital; ambulances and heavy pedestrian traffic."},
    {"name": "Gandhi Hospital, Musheerabad", "zone_type": RiskZone.ZoneType.HOSPITAL,
     "latitude": "17.424118", "longitude": "78.501995", "radius_m": 300, "risk_level": 5,
     "description": "Major government hospital; emergency access must stay clear."},
    {"name": "NIMS Hospital, Punjagutta", "zone_type": RiskZone.ZoneType.HOSPITAL,
     "latitude": "17.422175", "longitude": "78.451821", "radius_m": 250, "risk_level": 5,
     "description": "Nizam's Institute of Medical Sciences on a busy arterial road."},
    {"name": "Charminar and Laad Bazaar", "zone_type": RiskZone.ZoneType.MARKET,
     "latitude": "17.361602", "longitude": "78.474642", "radius_m": 400, "risk_level": 5,
     "description": "Dense heritage market area with very high footfall."},
    {"name": "Begum Bazaar market", "zone_type": RiskZone.ZoneType.MARKET,
     "latitude": "17.373079", "longitude": "78.470555", "radius_m": 350, "risk_level": 4,
     "description": "Wholesale market with heavy goods-vehicle and pedestrian traffic."},
    {"name": "Secunderabad Railway Station", "zone_type": RiskZone.ZoneType.TRANSIT,
     "latitude": "17.433859", "longitude": "78.502051", "radius_m": 400, "risk_level": 5,
     "description": "Main railway junction; buses, autos and crowds around the station."},
    {"name": "Hyderabad Deccan (Nampally) Railway Station", "zone_type": RiskZone.ZoneType.TRANSIT,
     "latitude": "17.392422", "longitude": "78.467596", "radius_m": 300, "risk_level": 4,
     "description": "Railway terminus in the old city centre."},
    {"name": "Ameerpet Metro Interchange", "zone_type": RiskZone.ZoneType.TRANSIT,
     "latitude": "17.435500", "longitude": "78.444790", "radius_m": 300, "risk_level": 4,
     "description": "Metro interchange between the Red and Blue lines; busy commercial street below."},
    {"name": "Paradise Circle junction", "zone_type": RiskZone.ZoneType.JUNCTION,
     "latitude": "17.442100", "longitude": "78.487400", "radius_m": 250, "risk_level": 4,
     "description": "Major traffic junction in Secunderabad."},
    {"name": "Cyber Towers junction, HITEC City", "zone_type": RiskZone.ZoneType.JUNCTION,
     "latitude": "17.450675", "longitude": "78.380143", "radius_m": 350, "risk_level": 4,
     "description": "IT-corridor junction with peak-hour congestion."},
    {"name": "Hyderabad Public School, Begumpet", "zone_type": RiskZone.ZoneType.SCHOOL,
     "latitude": "17.445999", "longitude": "78.457324", "radius_m": 250, "risk_level": 4,
     "description": "Large school campus; children walking along the main road."},
    {"name": "Osmania University campus, Tarnaka", "zone_type": RiskZone.ZoneType.SCHOOL,
     "latitude": "17.411324", "longitude": "78.527432", "radius_m": 500, "risk_level": 3,
     "description": "University campus with colleges, hostels and student traffic."},
]


def _sync(model, lookup, values, update_existing):
    """``update_or_create`` (or ``get_or_create`` when existing rows must be kept). Returns (obj, created)."""
    manager = model.objects
    if update_existing:
        return manager.update_or_create(**lookup, defaults=values)
    return manager.get_or_create(**lookup, defaults=values)


def _counter(total):
    return {"total": total, "created": 0, "updated": 0, "kept": 0}


def _count(summary, created, update_existing):
    key = "created" if created else ("updated" if update_existing else "kept")
    summary[key] += 1


def ensure_departments(*, update_existing=True):
    """Install / re-sync the default departments (natural key: ``code``)."""
    summary = _counter(len(DEFAULT_DEPARTMENTS))
    for spec in DEFAULT_DEPARTMENTS:
        values = {key: value for key, value in spec.items() if key != "code"}
        if Department.objects.filter(name__iexact=values["name"]).exclude(code=spec["code"]).exists():
            raise ReferenceDataError(
                f"Another department is already called '{values['name']}'; rename it or give it code {spec['code']}."
            )
        department, created = _sync(Department, {"code": spec["code"]}, values, update_existing)
        if not created and not update_existing:
            _fill_blank_contacts(department, spec)
        _count(summary, created, update_existing)
    return summary


def _fill_blank_contacts(department, spec):
    """Give an existing department the default contact details it lacks; values an admin entered are kept."""
    missing = [field for field in CONTACT_FIELDS if not getattr(department, field) and spec.get(field)]
    for field in missing:
        setattr(department, field, spec[field])
    if missing:
        department.save(update_fields=[*missing, "updated_at"])


def ensure_categories(*, update_existing=True):
    """Install / re-sync the default categories and their routing (natural key: ``slug``)."""
    departments = {department.code: department for department in Department.objects.all()}
    summary = _counter(len(DEFAULT_CATEGORIES))
    for spec in DEFAULT_CATEGORIES:
        values = {key: value for key, value in spec.items()
                  if key not in ("slug", "department", "secondary_department")}
        for field in ("department", "secondary_department"):
            code = spec[field]
            if code is not None and code not in departments:
                raise ReferenceDataError(f"Department {code} is missing; install the departments first.")
            values[field] = departments.get(code) if code else None
        values["is_active"] = True
        if CivicCategory.objects.filter(name__iexact=values["name"]).exclude(slug=spec["slug"]).exists():
            raise ReferenceDataError(
                f"Another category is already called '{values['name']}'; rename it or give it slug {spec['slug']}."
            )
        _, created = _sync(CivicCategory, {"slug": spec["slug"]}, values, update_existing)
        _count(summary, created, update_existing)
    return summary


def ensure_risk_zones(*, update_existing=True):
    """Install / re-sync the default Hyderabad risk zones (natural key: ``name``)."""
    summary = _counter(len(DEFAULT_RISK_ZONES))
    for spec in DEFAULT_RISK_ZONES:
        values = {key: value for key, value in spec.items() if key != "name"}
        values["is_active"] = True
        _, created = _sync(RiskZone, {"name": spec["name"]}, values, update_existing)
        _count(summary, created, update_existing)
    return summary


def ensure_ai_configuration():
    """Create the AIConfiguration singleton with the model defaults if missing. Returns (config, created)."""
    created = not AIConfiguration.objects.filter(pk=1).exists()
    return AIConfiguration.load(), created


def ensure_reference_data(*, update_existing=True):
    """Install all reference data in one transaction. Returns a summary dict for reporting."""
    with transaction.atomic():
        departments = ensure_departments(update_existing=update_existing)
        categories = ensure_categories(update_existing=update_existing)
        risk_zones = ensure_risk_zones(update_existing=update_existing)
        config, config_created = ensure_ai_configuration()
    return {
        "departments": departments,
        "categories": categories,
        "risk_zones": risk_zones,
        "ai_configuration": {"created": config_created, "config": config},
    }
