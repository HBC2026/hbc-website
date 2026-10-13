import { OTHER_HAZARD, uid, type JActivity, type JHazard } from './types';

/**
 * Starter templates: work activities and their typical hazards only. They carry NO control measures on purpose:
 * controls become "approved" only when the administrator reviews or generates them and confirms them.
 * Hazard strings are "Category" or "Category|specific wording".
 */
type Spec = [title: string, equipment: string, hazards: string[]];
const SPECS: { name: string; description: string; activities: Spec[] }[] = [
  { name: 'Concrete Cutting & Demolition', description: 'Cutting, chipping and breaking concrete, debris removal.', activities: [
    ['Area set-up, barricading and permit checks', 'Barricade tape, signage', ['Interference', 'Slip, Trip & Falls']],
    ['Concrete cutting with saw / grinder', 'Concrete saw, angle grinder, water supply', ['Machinery & Equipment', 'Noise', `${OTHER_HAZARD}|Concrete / silica dust`, 'Electricity']],
    ['Breaking and chipping with jackhammer', 'Jackhammer / breaker, compressor', ['Machinery & Equipment', 'Noise', 'Manual Task & Tools|Hand-arm vibration', 'Falling Objects']],
    ['Debris collection, loading and disposal', 'Wheelbarrow, loader, skip', ['Lifting & Carrying', 'Slip, Trip & Falls', 'On-Site Vehicle']],
  ] },
  { name: 'Welding & Hot Work', description: 'Welding, gas cutting and grinding under a hot work permit.', activities: [
    ['Hot work preparation and area clearance', 'Fire blankets, extinguishers', ['Fire', 'Interference']],
    ['Arc welding / gas cutting', 'Welding machine, cutting set, leads', ['Fire', 'Electricity', 'Chemical Hazard|Welding fumes', 'Objects with Sharp Edges']],
    ['Grinding of weld and base metal', 'Angle grinder', ['Machinery & Equipment', 'Noise', 'Objects with Sharp Edges']],
    ['Post-work cooling and fire watch', 'Extinguishers', ['Fire']],
  ] },
  { name: 'Scaffolding', description: 'Erection, use, inspection and dismantling of scaffolds.', activities: [
    ['Transport and handling of scaffold materials', 'Trolley, hoist', ['Lifting & Carrying', 'On-Site Vehicle', 'Objects with Sharp Edges']],
    ['Scaffold erection / dismantling', 'Scaffold tubes, couplers, platforms', ['Working at Height / Scaffold', 'Falling Objects', 'Manual Task & Tools']],
    ['Scaffold inspection and tagging', 'Scaffold tags', ['Working at Height / Scaffold']],
    ['Use and movement of mobile scaffold', 'Mobile scaffold tower', ['Working at Height / Scaffold', 'Slip, Trip & Falls']],
  ] },
  { name: 'Electrical Cable Installation', description: 'Cable tray, cable pulling and terminations.', activities: [
    ['Cable routing and pulling', 'Cable drums, rollers, pulling rope', ['Manual Task & Tools', 'Lifting & Carrying', 'Slip, Trip & Falls']],
    ['Cable tray installation at height', 'Ladders / scaffold, power tools', ['Working at Height / Scaffold', 'Falling Objects', 'Machinery & Equipment']],
    ['Cable termination and connection', 'Hand tools, crimping tools', ['Electricity', 'Objects with Sharp Edges']],
    ['Testing and energisation', 'Insulation tester, multimeter', ['Electricity']],
  ] },
  { name: 'Painting & Chemical Application', description: 'Surface preparation, painting and coating.', activities: [
    ['Surface preparation', 'Grinder, wire brush, blasting equipment', ['Machinery & Equipment', 'Noise', `${OTHER_HAZARD}|Dust inhalation`]],
    ['Mixing and application of paint / coating', 'Brushes, rollers, spray equipment', ['Chemical Hazard', 'Fire']],
    ['Painting at height', 'Scaffold / MEWP', ['Working at Height / Scaffold', 'Falling Objects']],
    ['Waste and container disposal', 'Waste drums', ['Chemical Hazard', 'Lifting & Carrying']],
  ] },
  { name: 'Excavation', description: 'Mechanical and manual excavation and backfilling.', activities: [
    ['Locating underground utilities', 'Cable locator, hand tools', ['Electricity|Buried power cables', 'Interference']],
    ['Mechanical excavation', 'Excavator, dump truck', ['Machinery & Equipment', 'On-Site Vehicle', 'Material in Uncontrolled Motion', 'Noise']],
    ['Manual excavation and trimming', 'Shovels, picks', ['Manual Task & Tools', 'Slip, Trip & Falls', 'Biological Hazard|Insects, snakes']],
    ['Trench work and backfilling', 'Shoring, compactor', [`${OTHER_HAZARD}|Trench collapse`, 'Falling Objects']],
  ] },
  { name: 'Lifting Operations', description: 'Crane and rigging operations.', activities: [
    ['Lift planning and set-up', 'Lift plan, barricades', ['Overhead Crane', 'Interference']],
    ['Rigging of the load', 'Slings, shackles, tag lines', ['Lifting & Carrying', 'Objects with Sharp Edges']],
    ['Lifting and placing the load', 'Crane, rigging gear', ['Overhead Crane', 'Material in Uncontrolled Motion', 'Falling Objects']],
    ['Crane / vehicle movement', 'Mobile crane', ['On-Site Vehicle']],
  ] },
  { name: 'Machinery Installation', description: 'Offloading, positioning, anchoring and hook-up of machinery.', activities: [
    ['Delivery and offloading', 'Truck, crane / forklift', ['On-Site Vehicle', 'Lifting & Carrying', 'Material in Uncontrolled Motion']],
    ['Positioning and anchoring', 'Jacks, rollers, anchor bolts', ['Material in Uncontrolled Motion', 'Machinery & Equipment', 'Manual Task & Tools']],
    ['Alignment and grouting', 'Levels, grout mixer', ['Chemical Hazard|Grout / cement', 'Manual Task & Tools']],
    ['Electrical hook-up and commissioning', 'Test equipment', ['Electricity', 'Machinery & Equipment', 'Noise']],
  ] },
  { name: 'Vehicle Access', description: 'Vehicle entry, movement, reversing and loading inside the facility.', activities: [
    ['Pre-entry vehicle checks', 'Vehicle checklist', ['On-Site Vehicle']],
    ['Vehicle movement inside the site', 'Vehicle', ['On-Site Vehicle', 'Interference', 'Slip, Trip & Falls']],
    ['Reversing and parking', 'Vehicle, banksman', ['On-Site Vehicle']],
    ['Loading and unloading', 'Vehicle, lifting aids', ['Lifting & Carrying', 'Material in Uncontrolled Motion']],
  ] },
  { name: 'General Maintenance', description: 'Routine maintenance and minor repairs.', activities: [
    ['Preparation and isolation of equipment', 'LOTO devices', ['Electricity', 'Machinery & Equipment']],
    ['Maintenance using hand and power tools', 'Hand tools, power tools', ['Manual Task & Tools', 'Objects with Sharp Edges', 'Noise']],
    ['Work at low height using ladders / platforms', 'Ladders, podium steps', ['Working at Height / Scaffold', 'Falling Objects']],
    ['Housekeeping and handover', 'Waste bags', ['Slip, Trip & Falls', 'Inadequate Lighting']],
  ] },
];

function hazard(spec: string): JHazard {
  const [category, custom] = spec.split('|');
  return { id: uid(), category, custom_name: custom ?? '', instructions: '', controls: [] };
}

export function starterTemplates(): { name: string; description: string; content: { activities: JActivity[] } }[] {
  return SPECS.map((t) => ({
    name: t.name,
    description: `${t.description} Starting structure only: review the activities, hazards and controls for suitability before use.`,
    content: { activities: t.activities.map(([title, equipment, hazards]) => ({ id: uid(), title, equipment, instructions: '', hazards: hazards.map(hazard) })) },
  }));
}
