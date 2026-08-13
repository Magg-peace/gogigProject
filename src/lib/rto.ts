/**
 * Indian RTO intelligence — deterministic, lookup-based decoding of a
 * registration string. No network, no model: given "MH12NW8556" we split it into
 * state code (MH), RTO district code (12), series (NW) and serial (8556), then
 * resolve state / office / district from a static table.
 *
 * Client-safe on purpose: the report page decodes without a round-trip, and the
 * worker imports the same module so stored and rendered values can never drift.
 */

export type PlateParts = {
  state_code: string;
  rto_code: string;
  series: string;
  serial: string;
};

export type RtoInfo = {
  vehicle_number: string;
  parts: PlateParts | null;
  state: string | null;
  rto_office: string | null;
  district: string | null;
  category: string;
  category_basis: string;
  is_bharat_series: boolean;
  /** 0..1 — how much of the decode came from an exact table hit. */
  decode_confidence: number;
  notes: string[];
};

const STATES: Record<string, string> = {
  AN: "Andaman & Nicobar Islands", AP: "Andhra Pradesh", AR: "Arunachal Pradesh",
  AS: "Assam", BR: "Bihar", CG: "Chhattisgarh", CH: "Chandigarh", DD: "Daman & Diu",
  DL: "Delhi", DN: "Dadra & Nagar Haveli", GA: "Goa", GJ: "Gujarat", HP: "Himachal Pradesh",
  HR: "Haryana", JH: "Jharkhand", JK: "Jammu & Kashmir", KA: "Karnataka", KL: "Kerala",
  LA: "Ladakh", LD: "Lakshadweep", MH: "Maharashtra", ML: "Meghalaya", MN: "Manipur",
  MP: "Madhya Pradesh", MZ: "Mizoram", NL: "Nagaland", OD: "Odisha", OR: "Odisha",
  PB: "Punjab", PY: "Puducherry", RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu",
  TR: "Tripura", TS: "Telangana", UK: "Uttarakhand", UA: "Uttarakhand",
  UP: "Uttar Pradesh", WB: "West Bengal",
};

/** state code -> rto district code -> [office, district] */
const OFFICES: Record<string, Record<string, [string, string]>> = {
  MH: {
    "01": ["Mumbai Central RTO", "Mumbai City"], "02": ["Mumbai West RTO", "Mumbai Suburban"],
    "03": ["Mumbai East RTO", "Mumbai Suburban"], "04": ["Thane RTO", "Thane"],
    "05": ["Kalyan RTO", "Thane"], "10": ["Sangli RTO", "Sangli"],
    "11": ["Satara RTO", "Satara"], "12": ["Pune RTO", "Pune"],
    "13": ["Solapur RTO", "Solapur"], "14": ["Pimpri-Chinchwad RTO", "Pune"],
    "15": ["Nashik RTO", "Nashik"], "16": ["Ahmednagar RTO", "Ahmednagar"],
    "18": ["Dhule RTO", "Dhule"], "19": ["Jalgaon RTO", "Jalgaon"],
    "20": ["Chhatrapati Sambhajinagar RTO", "Chhatrapati Sambhajinagar"],
    "27": ["Amravati RTO", "Amravati"], "31": ["Nagpur RTO", "Nagpur"],
    "43": ["Navi Mumbai RTO", "Thane"], "46": ["Panvel RTO", "Raigad"],
    "47": ["Mumbai North RTO", "Mumbai Suburban"], "48": ["Vasai RTO", "Palghar"],
  },
  DL: {
    "01": ["Mall Road RTO", "North Delhi"], "02": ["Tilak Marg RTO", "New Delhi"],
    "03": ["Sheikh Sarai RTO", "South Delhi"], "04": ["Janakpuri RTO", "West Delhi"],
    "05": ["Loni Road RTO", "East Delhi"], "07": ["Mayur Vihar RTO", "East Delhi"],
    "08": ["Wazirpur RTO", "North West Delhi"], "09": ["Dwarka RTO", "South West Delhi"],
    "10": ["Raja Garden RTO", "West Delhi"], "12": ["Vasant Vihar RTO", "South West Delhi"],
    "13": ["Rohini RTO", "North West Delhi"], "14": ["Sarai Kale Khan RTO", "South East Delhi"],
  },
  KA: {
    "01": ["Koramangala RTO", "Bengaluru"], "02": ["Rajajinagar RTO", "Bengaluru"],
    "03": ["Indiranagar RTO", "Bengaluru"], "04": ["Yeshwanthpur RTO", "Bengaluru"],
    "05": ["Jayanagar RTO", "Bengaluru"], "09": ["Mysuru RTO", "Mysuru"],
    "19": ["Mangaluru RTO", "Dakshina Kannada"], "20": ["Udupi RTO", "Udupi"],
    "41": ["Electronic City RTO", "Bengaluru"], "51": ["Bengaluru East RTO", "Bengaluru"],
  },
  TN: {
    "01": ["Chennai Central RTO", "Chennai"], "02": ["Chennai North East RTO", "Chennai"],
    "07": ["Chennai North West RTO", "Chennai"], "09": ["Chennai South RTO", "Chennai"],
    "10": ["Chennai West RTO", "Chennai"], "37": ["Coimbatore South RTO", "Coimbatore"],
    "38": ["Coimbatore North RTO", "Coimbatore"], "45": ["Tiruchirappalli RTO", "Tiruchirappalli"],
    "58": ["Madurai South RTO", "Madurai"],
  },
  UP: {
    "14": ["Ghaziabad RTO", "Ghaziabad"], "16": ["Noida RTO", "Gautam Buddh Nagar"],
    "32": ["Lucknow RTO", "Lucknow"], "65": ["Varanasi RTO", "Varanasi"],
    "70": ["Prayagraj RTO", "Prayagraj"], "78": ["Kanpur RTO", "Kanpur Nagar"],
    "80": ["Agra RTO", "Agra"],
  },
  GJ: {
    "01": ["Ahmedabad RTO", "Ahmedabad"], "05": ["Surat RTO", "Surat"],
    "06": ["Vadodara RTO", "Vadodara"], "18": ["Gandhinagar RTO", "Gandhinagar"],
    "27": ["Ahmedabad East RTO", "Ahmedabad"],
  },
  RJ: { "14": ["Jaipur RTO", "Jaipur"], "19": ["Jodhpur RTO", "Jodhpur"], "27": ["Udaipur RTO", "Udaipur"] },
  WB: { "01": ["Kolkata Beltala RTO", "Kolkata"], "06": ["Kolkata RTO", "Kolkata"], "26": ["Barasat RTO", "North 24 Parganas"] },
  HR: { "26": ["Gurugram RTO", "Gurugram"], "51": ["Faridabad RTO", "Faridabad"], "05": ["Karnal RTO", "Karnal"] },
  TS: { "07": ["Hyderabad East RTO", "Hyderabad"], "09": ["Hyderabad Central RTO", "Hyderabad"], "10": ["Secunderabad RTO", "Hyderabad"] },
  AP: { "16": ["Vijayawada RTO", "Krishna"], "31": ["Visakhapatnam RTO", "Visakhapatnam"] },
  KL: { "01": ["Thiruvananthapuram RTO", "Thiruvananthapuram"], "07": ["Ernakulam RTO", "Ernakulam"], "11": ["Kozhikode RTO", "Kozhikode"] },
  MP: { "04": ["Bhopal RTO", "Bhopal"], "09": ["Indore RTO", "Indore"], "20": ["Jabalpur RTO", "Jabalpur"] },
  PB: { "02": ["Amritsar RTO", "Amritsar"], "08": ["Jalandhar RTO", "Jalandhar"], "10": ["Ludhiana RTO", "Ludhiana"] },
  BR: { "01": ["Patna RTO", "Patna"], "10": ["Gaya RTO", "Gaya"] },
  CH: { "01": ["Chandigarh RTO", "Chandigarh"] },
  GA: { "01": ["Panaji RTO", "North Goa"], "07": ["Margao RTO", "South Goa"] },
};

/** Series letters that indicate a transport (commercial) vehicle in common use. */
const COMMERCIAL_SERIES = new Set(["T", "TC", "TP", "GA", "GB", "GC", "GD", "GE", "GF", "GG"]);

export const PLATE_PATTERN = /^([A-Z]{2})([0-9]{1,2})([A-Z]{0,3})([0-9]{4})$/;
export const BHARAT_PATTERN = /^([0-9]{2})(BH)([0-9]{4})([A-Z]{1,2})$/;

export function parsePlate(value: string): PlateParts | null {
  const v = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const bh = v.match(BHARAT_PATTERN);
  if (bh) return { state_code: "BH", rto_code: bh[1]!, series: bh[4]!, serial: bh[3]! };
  const m = v.match(PLATE_PATTERN);
  if (!m) return null;
  return { state_code: m[1]!, rto_code: m[2]!.padStart(2, "0"), series: m[3]! || "—", serial: m[4]! };
}

export function decodeRto(vehicleNumber: string | null | undefined): RtoInfo | null {
  if (!vehicleNumber) return null;
  const value = vehicleNumber.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const parts = parsePlate(value);
  const notes: string[] = [];
  if (!parts) {
    return {
      vehicle_number: value,
      parts: null,
      state: null,
      rto_office: null,
      district: null,
      category: "Undetermined",
      category_basis: "Registration string does not match any known Indian plate grammar.",
      is_bharat_series: false,
      decode_confidence: 0,
      notes: ["Could not split the string into state / RTO / series / serial."],
    };
  }

  const isBharat = parts.state_code === "BH";
  if (isBharat) {
    return {
      vehicle_number: value,
      parts,
      state: "Bharat (BH) series — nationwide",
      rto_office: "Bharat Series (central registration)",
      district: "Not district-bound",
      category: "Private vehicle (BH series)",
      category_basis: "BH-series registration is issued to eligible private owners for pan-India use.",
      is_bharat_series: true,
      decode_confidence: 0.9,
      notes: [`Registered in ${20}${parts.rto_code} under the Bharat series scheme.`],
    };
  }

  const state = STATES[parts.state_code] ?? null;
  const office = OFFICES[parts.state_code]?.[parts.rto_code] ?? null;
  if (!state) notes.push(`State code "${parts.state_code}" is not in the lookup table.`);
  if (state && !office)
    notes.push(
      `RTO code ${parts.rto_code} is not in the offline office table for ${state}; state-level decode only.`,
    );

  const seriesHead = parts.series === "—" ? "" : parts.series;
  const commercial = COMMERCIAL_SERIES.has(seriesHead) || /^T[A-Z]?$/.test(seriesHead);
  const category = commercial ? "Transport / commercial vehicle" : "Private vehicle (non-transport)";
  const basis = commercial
    ? `Series "${seriesHead}" falls in the range commonly allotted to transport vehicles.`
    : `Series "${seriesHead || "n/a"}" is outside the common transport ranges; white-plate private registration inferred.`;

  const confidence = office ? 0.95 : state ? 0.6 : 0.2;
  return {
    vehicle_number: value,
    parts,
    state,
    rto_office: office?.[0] ?? null,
    district: office?.[1] ?? null,
    category,
    category_basis: `${basis} Plate colour is not observable from the number alone, so category is an inference, not a registry lookup.`,
    is_bharat_series: false,
    decode_confidence: confidence,
    notes,
  };
}

export function formatPlate(value: string | null | undefined): string {
  if (!value) return "—";
  const p = parsePlate(value);
  if (!p) return value;
  return [p.state_code, p.rto_code, p.series === "—" ? "" : p.series, p.serial].filter(Boolean).join(" ");
}
