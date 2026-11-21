import type { JobCategoryId, JobSubcategoryId } from './taxonomy';

// v33 ROLES (F3, "category them as much as possible"): the title rules for work outside software, read by
// `categorizeTitle` (./infer.ts). Two lists: FIELD_RULES run before every v3.2 rule (a nurse, a security guard, a data
// entry clerk or a retail sales associate is never a software, cybersecurity, data or B2B sales job), FIELD_CATCH_ALLS
// after them all (a bare "Clerk", "Writer" or "Operator", which a v3.2 rule may name more precisely first).
//
// A field rule never fires on a technology title (TECH_TITLE: "Software Engineer, Nurse Scheduling" stays software)
// nor on a recruiter's ("Nurse Recruiter" stays People & HR): `categorizeTitle` checks both once per title. Order
// matters only between categories (the first matching rule names the category); within one, every matching rule adds
// its subcategory, a catch-all's only when nothing finer matched.

/** A field rule: its pattern, category, subcategory, and whether it is a catch-all (as infer.ts's rules). */
export type FieldTitleRule = readonly [RegExp, JobCategoryId, JobSubcategoryId | null, boolean?];

/**
 * Words that make a title a technology role: a field rule never fires on a title that has one. "Developer" after
 * curriculum, e-learning, course or content words is a course writer's, not a programmer's.
 */
export const TECH_TITLE = new RegExp(
  String.raw`\b(?:software|(?<!(?:curriculum|e-?learning|learning|course|content)\s)developers?|programmers?|programming|swe|sdet|sde|` +
    String.raw`devops|devsecops|sre|full[\s-]?stack|frontend|backend|front-end\s+(?:developer|engineer)|firmware|embedded|kubernetes|k8s|` +
    String.raw`cloud|machine\s+learning|deep\s+learning|ml|ai|llms?|gen\s?ai|cyber\s?security|cyber|infosec|information\s+security|` +
    String.raw`data\s+(?:scientists?|science|engineers?|engineering|analysts?|analytics|architects?|platform|pipelines?|warehous\w*|min\w*)|` +
    String.raw`ios|android|blockchain|web3|salesforce|servicenow|sap|device\s+drivers?|kernel|it|saas|apis?|computer\s+vision|nlp|robotics?)\b`,
  'i',
);

/** A recruiter for a field is People & HR's, whatever the field. */
export const RECRUITING_TITLE = /\brecruit/i;

const R = (pattern: RegExp, category: JobCategoryId, subcategory: JobSubcategoryId | null, catchAll = false): FieldTitleRule => [
  pattern,
  category,
  subcategory,
  catchAll,
];

/** Before every v3.2 rule. In order: protective services, personal care, healthcare, education, hospitality, ... */
export const FIELD_RULES: readonly FieldTitleRule[] = [
  // --- protective services
  R(
    /(?<!\b(?:information|cyber|it|data|chief|cloud|application|product|network|systems?|technology|privacy|compliance)\s+)\bsecurity\s+(?:guards?|officers?|patrol\w*|screeners?)\b|\b(?:armed|unarmed|campus|hospital|event)\s+(?:security|guards?)\b|\bguards?\b|\bbouncer\b|\bdoor\s+supervisor\b/i,
    'protective-services',
    'security-guard',
  ),
  R(/\bloss\s+prevention\b|\basset\s+protection\b/i, 'protective-services', 'loss-prevention'),
  R(
    /\b(?:police|patrol|correction(?:al|s)|detention|probation|parole|peace|transit\s+police)\s+officers?\b|\bpolice\b|\bsheriff\b|\btrooper\b|\bdetectives?\b|\bjailer\b|\bbailiff\b/i,
    'protective-services',
    'law-enforcement',
  ),
  R(
    /\bfire\s?fighters?\b|\bfire\s+(?:captain|lieutenant|chief|inspector|marshal|apparatus\s+engineer)\b|\bsearch\s+and\s+rescue\b|\blifeguards?\b/i,
    'protective-services',
    'fire-rescue',
  ),
  R(
    /\b(?:911|9-1-1|emergency|police|fire|public\s+safety)\s+(?:communications\s+)?(?:dispatchers?|telecommunicators?|call\s+takers?)\b|\bemergency\s+(?:management|planner|preparedness)\b/i,
    'protective-services',
    'emergency-dispatch',
  ),

  // --- personal care (before healthcare and education: a massage therapist, a yoga teacher)
  R(
    /\b(?:hair\s*stylists?|stylists?|hairdressers?|barbers?|cosmetologists?|estheticians?|aestheticians?|nail\s+(?:technician|tech|artist)s?|manicurists?|makeup\s+artists?|lash\s+(?:artist|technician)s?|salon\s+(?:assistant|manager|coordinator|receptionist|associate)|beauty\s+(?:advisor|consultant|associate|therapist)|brow\s+(?:artist|specialist)|waxing\s+specialist)\b/i,
    'personal-care-services',
    'beauty-cosmetology',
  ),
  R(
    /\bpersonal\s+trainers?\b|\bfitness\s+(?:instructor|trainer|coach|specialist|manager|director|coordinator|attendant)s?\b|\b(?:yoga|pilates|spin|cycling|barre|zumba|group\s+fitness|aerobics|dance|swim(?:ming)?|martial\s+arts)\s+(?:instructor|teacher|coach)s?\b|\bstrength\s+(?:and|&)\s+conditioning\b|\bathletic\s+trainer\b|\bgym\s+(?:attendant|manager|staff)\b|\bwellness\s+(?:coach|coordinator|specialist)\b|\bhealth\s+coach\b|\blife\s+coach\b/i,
    'personal-care-services',
    'fitness-wellness',
  ),
  R(
    /\bmassage\b|\blmt\b|\bspa\s+(?:attendant|therapist|manager|coordinator|concierge|director|receptionist)\b|\bbody\s?work(?:er)?\b|\breflexologist\b/i,
    'personal-care-services',
    'massage-spa',
  ),
  R(
    /\bnann(?:y|ies)\b|\bbabysitters?\b|\bau\s+pair\b|\bgoverness\b|\b(?:mother|parent)['’]?s\s+helper\b|\bin-?home\s+child\s?care\b/i,
    'personal-care-services',
    'childcare-nanny',
  ),
  R(
    /\b(?:pet|dog|animal)\s+(?:groomer|grooming|sitter|walker|trainer|bather|handler|caretaker|care\s+(?:attendant|specialist|associate|technician))s?\b|\bgroomers?\b|\bkennel\s+(?:attendant|technician|assistant|worker|manager)\b|\bpet\s+stylist\b/i,
    'personal-care-services',
    'pet-care',
  ),

  // --- healthcare
  R(
    /\b(?:medical|dental|clinic|clinical|patient|hospital|health\s+unit|unit)\s+(?:receptionists?|secretar(?:y|ies)|office\s+(?:assistant|administrator|manager|specialist|coordinator)|administrative\s+(?:assistant|specialist|coordinator)|front\s+desk|schedulers?|scheduling|billers?|billing|coders?|coding|records|clerks?|registrars?|access|registration|services\s+(?:representative|coordinator|specialist)|transcriptionists?|scribes?)\b|\bhealth\s+information\b|\bcertified\s+(?:professional\s+)?coder\b|\brevenue\s+cycle\b|\bmedical\s+office\b|\b(?:healthcare|health\s+care|clinical|medical|hospital|clinic|practice)\s+administrators?\b/i,
    'healthcare',
    'medical-administration',
  ),
  R(
    /\bnurses?\b(?!\s+(?:practitioner|anesthetist|midwife|assistant|aide))|\bnursing\b(?!\s+(?:assistant|aide))|\b(?:rn|lpn|lvn|bsn|msn)\b/i,
    'healthcare',
    'nursing',
  ),
  R(
    /\b(?:certified\s+)?nurs(?:e|ing)\s+(?:assistant|aide)s?\b|\bcna\b|\bpatient\s+care\s+(?:technician|tech|assistant|associate)\b|\bpct\b|\bmedication\s+aide\b|\bhospital\s+(?:aide|attendant)\b|\borderly\b/i,
    'healthcare',
    'nursing-assistant',
  ),
  R(
    /\bphysicians?\b(?!\s+(?:liaison|relations))|\bdoctors?\b|\bsurgeons?\b|\bhospitalist\b|\bpsychiatrist\b|\banesthesiologist\b|\bradiologist\b|\bnurse\s+(?:practitioner|anesthetist|midwife)\b|\bphysician\s+assistant\b|\b(?:np|pa-c|crna)\b|\bmidwife\b|\boptometrist\b|\bchiropractor\b|\bpodiatrist\b|\bdermatologist\b|\bpediatrician\b|\bcardiologist\b|\boncologist\b/i,
    'healthcare',
    'physicians-advanced-practice',
  ),
  R(
    /\bmedical\s+assistants?\b|\b(?:medical|clinical)\s+lab(?:oratory)?\b|\b(?:mls|mlt|cma|rma)\b|\bphlebotom\w*|\b(?:radiologic|radiology|x-?ray|mri|ct|ultrasound|surgical|cardiovascular|nuclear\s+medicine|ekg|ecg|eeg|histology|cytology|polysomnographic|sterile\s+processing|anesthesia|ophthalmic|optometric|dialysis|cath\s+lab)\s+(?:technologist|technician|tech|assistant)s?\b|\bsonographers?\b|\bradiographers?\b|\bmammographer\b|\bdietitians?\b|\bnutritionists?\b|\bopticians?\b|\bperfusionist\b|\bsterile\s+processing\b/i,
    'healthcare',
    'allied-health',
  ),
  R(
    /\b(?:physical|occupational|speech|respiratory|recreational|music|art)\s+therap(?:ist|y\s+assistant)s?\b|\bspeech[\s-]+language\s+pathologists?\b|\bslp\b|\bphysiotherapists?\b|\brehab(?:ilitation)?\s+(?:aide|technician|tech|therapist|specialist)\b|\baudiologist\b/i,
    'healthcare',
    'therapy-rehabilitation',
  ),
  R(
    /\bpharmacists?\b|\bpharmacy\s+(?:technician|tech|assistant|manager|intern|clerk|associate)s?\b/i,
    'healthcare',
    'pharmacy',
  ),
  R(
    /\bdentists?\b|\bdental\s+(?:assistant|hygienist|technician|lab|office\s+manager)s?\b|(?<!industrial\s)\bhygienists?\b|\borthodontist\b|\bendodontist\b|\boral\s+surgeon\b/i,
    'healthcare',
    'dental',
  ),
  R(
    /\b(?:mental\s+health|behavioral\s+health|substance\s+(?:abuse|use)|addiction|chemical\s+dependency)\b|\bpsychologists?\b|\btherapists?\b|\bpsychotherapists?\b|\b(?:lpc|lmhc|lmft|bcba|rbt)\b|\bbehavior(?:al)?\s+(?:technician|tech|analyst|interventionist|specialist)s?\b|\bpeer\s+(?:support|specialist|recovery)\b/i,
    'healthcare',
    'behavioral-health',
    true,
  ),
  R(
    /\bhome\s+(?:health|care)\b|\bcare\s?givers?\b|\b(?:personal|direct)\s+care\s+(?:aide|assistant|worker|professional|staff)s?\b|\bdirect\s+support\s+professional\b|\b(?:dsp|hha|pca)\b|\bhospice\s+aide\b/i,
    'healthcare',
    'home-health',
  ),
  R(/\b(?:emt|emt-b|paramedics?|emergency\s+medical\s+technician|ambulance)\b/i, 'healthcare', 'emergency-medical'),
  R(
    /\bveterinar(?:ian|y)s?\b|\bvet\s+(?:tech|technician|assistant)s?\b|\banimal\s+health\s+(?:technician|tech)\b/i,
    'healthcare',
    'veterinary',
  ),

  // --- education
  R(
    /\binstructional\s+(?:designer|design|technologist|coordinator)s?\b|\bcurriculum\s+(?:designer|developer|writer|specialist|coordinator)s?\b|\blearning\s+(?:experience\s+)?designers?\b|\be-?learning\s+(?:developer|designer|specialist)s?\b/i,
    'education',
    'instructional-design',
  ),
  R(
    /\b(?:preschool|pre-k|pre-?kindergarten|daycare|day\s+care|childcare|child\s+care|early\s+(?:childhood|learning|education)|infant|toddler|head\s+start)\s+(?:teachers?|educators?|assistants?|aides?|workers?|providers?|directors?|caregivers?|specialists?)\b|\bearly\s+childhood\b/i,
    'education',
    'early-childhood',
  ),
  R(
    /\bspecial\s+(?:education|ed|needs)\b|\bsped\b|\b(?:autism|resource\s+room|intervention)\s+(?:teacher|specialist)s?\b/i,
    'education',
    'special-education',
  ),
  R(
    /\bteach(?:er['’]?s?|ing)\s+(?:assistant|aide)s?\b|\bparaprofessionals?\b|\bparaeducators?\b|\binstructional\s+aide\b|\bclassroom\s+(?:aide|assistant)s?\b/i,
    'education',
    'teaching-assistant',
  ),
  R(
    /\bprofessors?\b|\blecturers?\b|\badjunct\b|\bfaculty\b|\bdean\b|\bpostdoc\w*|\bpost-?doctoral\b|\bprovost\b/i,
    'education',
    'higher-education',
  ),
  R(
    /\b(?:school|assistant|elementary|middle\s+school|high\s+school|vice)\s+principal\b|\bschool\s+(?:counselor|administrator|secretary|librarian)s?\b|\bguidance\s+counselor\b|\b(?:academic|college|student)\s+(?:advisor|adviser|counselor|success\s+coach|services\s+coordinator)s?\b|\badmissions?\s+(?:counselor|officer|advisor|coordinator|director|representative)s?\b|\bregistrar\b/i,
    'education',
    'school-administration',
  ),
  R(/\btutors?\b|\btutoring\b|\b(?:driving|piano|guitar|language|esl)\s+(?:instructor|teacher|coach)s?\b|\bliteracy\s+(?:coach|specialist|tutor)\b|\breading\s+specialist\b/i, 'education', 'tutoring-instruction'),
  R(/\bteachers?\b|\bk-?12\b|\beducators?\b/i, 'education', 'k12-teaching', true),

  // --- legal, finance and HR roles v3.2 had no subcategory for
  R(
    /\bparalegals?\b|\blegal\s+(?:assistant|secretary|administrative\s+assistant|clerk|support\s+(?:specialist|assistant)|document\s+specialist)s?\b|\blitigation\s+(?:assistant|support|secretary)\b|\bdocket(?:ing)?\s+(?:clerk|specialist|coordinator)\b|\bcourt\s+(?:clerk|reporter)s?\b|\blaw\s+clerk\b|\bconveyancer\b/i,
    'legal',
    'paralegal',
  ),
  R(/\bpayroll\b/i, 'people-hr', 'payroll'),
  R(
    /\b(?:bank|banking|branch|universal|personal)\s+(?:teller|banker|associate|officer|representative|specialist)s?\b|\btellers?\b|\b(?:personal|universal|relationship)\s+bankers?\b|(?<!customer\s)\brelationship\s+(?:manager|officer)\b(?=.*\b(?:bank|banking|credit|lending|commercial|wealth)\b)|\bloan\s+(?:officer|processor|closer|originator|servicing|specialist|underwriter|consultant|assistant|coordinator)s?\b|\bmortgage\s+(?:loan\s+)?(?:officer|processor|underwriter|closer|consultant|banker|broker|specialist|originator)s?\b|\bcredit\s+(?:analyst|officer|specialist|underwriter)s?\b|\bcollections?\s+(?:specialist|agent|representative|analyst|manager|associate)s?\b|\bdebt\s+collector\b|\bbranch\s+manager\b|(?<!(?:food|blood|data)\s)\bbank\b/i,
    'finance',
    'banking-operations',
  ),
  R(
    /\bclaims?\s+(?:adjuster|examiner|representative|specialist|processor|analyst|associate|handler|manager|investigator|supervisor|assistant|adjudicator|administrator|coordinator)s?\b|\binsurance\s+(?:underwriter|claims|specialist|coordinator|verification|processor|analyst|representative|account\s+manager)s?\b|(?<!\b(?:mortgage|loan|credit)\s)\bunderwriters?\b|\bunderwriting\b|\bactuar(?:y|ial|ies)\b|\bloss\s+adjuster\b|\bpolicy\s+services?\s+(?:representative|specialist)\b/i,
    'finance',
    'insurance-underwriting-claims',
  ),
  R(/\binsurance\s+(?:sales\s+)?(?:agent|producer|advisor|broker|salesperson)s?\b|\blicensed\s+(?:insurance\s+)?agent\b/i, 'sales-solutions', null),
  R(
    /\bcall\s+cent(?:er|re)\b|\bcontact\s+cent(?:er|re)\b|\btelemarket\w*|\bcall\s+(?:handler|agent|representative)s?\b|\b(?:inbound|outbound)\s+(?:call\s+)?(?:customer\s+)?(?:service\s+)?(?:representative|agent|associate)s?\b/i,
    'customer-success',
    'call-center',
  ),

  // --- hospitality and food service (before the office's front desk: a hotel's front desk is hospitality's)
  R(
    /\b(?:sous|executive|head|pastry|line|prep|private|personal)\s+(?:chef|cook)s?\b|\bchefs?\b|\bcooks?\b|\bkitchen\s+(?:staff|assistant|helper|porter|lead)s?\b|\bdish\s?washers?\b|\bfood\s+(?:prep|preparation)\b|\bfood\s+service\s+(?:worker|associate|aide)s?\b|\bbakers?\b|\bculinary\b|\bcatering\s+(?:assistant|cook|chef)s?\b/i,
    'hospitality-food',
    'culinary',
  ),
  R(
    /(?<!(?:sql|web|windows|linux|mail|file|application|app|game|media|proxy|database|print|exchange)\s)\b(?:servers?)\b(?!\s+(?:administrator|admin|engineer|technician|architect|support|infrastructure|operations|hardware|virtualization|side))|\bwaiters?\b|\bwaitress(?:es)?\b|\bwait\s?staff\b|\bbartenders?\b|\bbaristas?\b|\bbussers?\b|\bfood\s+runners?\b|\bhostess(?:es)?\b|\b(?:restaurant|dining|banquet)\s+(?:host|captain|attendant|staff)s?\b|\bsommeliers?\b|\bcrew\s+members?\b|\bfront\s+of\s+house\b|\bconcessions?\b/i,
    'hospitality-food',
    'food-beverage-service',
  ),
  R(
    /\b(?:restaurant|kitchen|dining\s+room|food\s+and\s+beverage|f&b|bar|cafe|café|catering|banquet|food\s+service)\s+(?:general\s+)?(?:manager|supervisor|director|lead)s?\b|\bfood\s+and\s+beverage\b|\bf&b\b/i,
    'hospitality-food',
    'restaurant-management',
  ),
  R(
    /\bhotel\s+(?:general\s+manager|manager|front\s+desk|clerk|staff|associate|attendant|operations|housekeeper|receptionist)\b|\bhousekeep(?:er|ers|ing)\b|\broom\s+attendants?\b|\bguest\s+(?:service|services|relations|experience)\s+(?:agent|associate|representative|manager|supervisor)s?\b|\bfront\s+(?:desk|office)\s+(?:agent|associate|clerk|supervisor|manager)s?\b(?=.*\b(?:hotel|resort|inn|lodge|guest)\b)|\bnight\s+auditor\b|\bconcierge\b|\bbell\s?(?:hop|man|person|staff|attendant)s?\b|\bvalets?\b|\binnkeeper\b/i,
    'hospitality-food',
    'hotel-lodging',
  ),
  R(
    /\bevents?\s+(?:coordinator|planner|manager|specialist|assistant|producer|staff|director)s?\b|\bwedding\s+(?:planner|coordinator)s?\b|\bmeeting\s+planners?\b|\btravel\s+(?:agent|consultant|advisor|counselor|coordinator)s?\b|\btour\s+(?:guide|operator|leader)s?\b/i,
    'hospitality-food',
    'events-travel',
  ),

  // --- retail (before v3.2's sales rules: a retail sales associate is not B2B sales)
  R(
    /\bcashiers?\b|\bcheck-?out\s+(?:associate|clerk|operator)s?\b|\bfront\s+end\s+(?:associate|cashier|supervisor|lead)s?\b|\bself-?checkout\b/i,
    'retail',
    'cashier',
  ),
  R(
    /(?<!\bapp\s)\bstore\s+(?:manager|director|lead|leader|supervisor)s?\b|\bretail\s+(?:store\s+)?(?:manager|supervisor|team\s+lead(?:er)?)s?\b|\bkey\s?holders?\b/i,
    'retail',
    'store-management',
  ),
  R(
    /\bmerchandis(?:er|ers|ing)\b|\bstockers?\b|\bstock\s+(?:associate|clerk|person|team\s+member)s?\b|\b(?:grocery|deli|bakery|produce|meat|dairy|frozen)\s+(?:clerk|associate|team\s+member|manager|lead|cutter)s?\b|\bbutchers?\b|\bmeat\s+cutters?\b|\bplanogram\b/i,
    'retail',
    'merchandising-stocking',
  ),
  R(
    /(?<!\b(?:inside|b2b)\s)\bsales\s+(?:associate|floor\s+associate|clerk|person|advisor)s?\b|\bsalespersons?\b|\bretail\s+(?:sales|associate|clerk|team\s+member|worker|assistant|specialist|consultant)s?\b|\bstore\s+(?:associate|clerk|team\s+member|employee|worker)s?\b|\bshop\s+assistants?\b/i,
    'retail',
    'retail-sales',
  ),

  // --- administrative and office
  R(/\bexecutive\s+(?:assistant|administrative\s+assistant|secretary|administrator)s?\b|\bpersonal\s+assistants?\b/i, 'administrative-office', 'executive-assistant'), // v33 FIX-1: administrator
  R(
    /\b(?:administrative|admin|office|virtual|clerical|department|front\s+office)\s+(?:assistant|support\s+(?:specialist|assistant))s?\b|\badministrative\s+(?:specialist|coordinator|associate|support|officer|aide|clerk|secretary|professional)s?\b|\badmin\s+(?:coordinator|specialist|support|officer)s?\b/i,
    'administrative-office',
    'administrative-assistant',
  ),
  R(
    /\boffice\s+(?:manager|administrator|coordinator|supervisor|lead|operations\s+manager|services\s+(?:manager|coordinator))s?\b|\bfront\s+office\s+(?:manager|supervisor)\b|\bworkplace\s+(?:coordinator|experience\s+(?:coordinator|associate|manager))\b/i,
    'administrative-office',
    'office-management',
  ),
  R(
    /\breceptionists?\b|\bfront\s+desk\b|\bswitchboard\s+operators?\b|\btelephone\s+operators?\b|\bwelcome\s+desk\b/i,
    'administrative-office',
    'reception',
  ),
  R(
    /\bdata\s+entry\b|\bdata\s+(?:input|capture)\s+(?:clerk|operator|specialist)s?\b|\brecords?\s+(?:clerk|specialist|coordinator|technician|manager|management|assistant|keeper)s?\b|\bfil(?:e|ing)\s+clerks?\b|\bdocument\s+(?:control|controller|specialist|processor|imaging)\b|\bscanning\s+(?:clerk|operator|technician)s?\b|\btranscriptionists?\b|\btypists?\b/i,
    'administrative-office',
    'data-entry-records',
  ),
  R(
    /\bsecretar(?:y|ies)\b(?!\s+of\s+state)|\bclerical\b|\bmail\s?room\b|\bmail\s+(?:clerk|services)\b|\boffice\s+(?:clerk|helper|support|associate|worker)s?\b|\bgeneral\s+office\b|\bschedulers?\b(?!.*\b(?:production|master|maintenance)\b)/i,
    'administrative-office',
    'office-clerical',
  ),

  // --- warehouse and logistics
  R(
    /\bfork\s?lift\b|\breach\s+truck\b|\bpallet\s+jack\b|\bmaterials?\s+handlers?\b|\bpower\s+industrial\s+truck\b|\bloaders?\b|\bunloaders?\b|\blumpers?\b|\bdock\s+(?:worker|associate|hand|loader)s?\b/i,
    'logistics-warehouse',
    'material-handling',
  ),
  R(
    /\bwarehouse\s+(?:associate|worker|team\s+member|operative|clerk|helper|labou?rer|labor|staff|specialist|technician|attendant|operator)s?\b|\b(?:order\s+)?pickers?\b|\bpackers?\b|\bpick(?:er)?\s+(?:and|&|\/)\s+pack(?:er)?\b|\border\s+(?:selector|filler|puller)s?\b|\bfulfillment\s+(?:associate|specialist|worker|team\s+member)s?\b|\bdistribution\s+(?:center\s+)?(?:associate|worker|team\s+member)s?\b|\blogistics\s+(?:associate|worker|team\s+member|operative|helper|handler)s?\b|\bsort(?:ation|ers?)\b|\b(?:package|parcel)\s+(?:handler|sorter)s?\b/i,
    'logistics-warehouse',
    'warehouse-operations',
  ),
  R(
    /\binventory\s+(?:control|specialist|clerk|associate|analyst|coordinator|manager|auditor|lead|supervisor)s?\b|\bcycle\s+counters?\b|\bstock\s+controller\b/i,
    'logistics-warehouse',
    'inventory-control',
  ),
  R(
    /\bshipping\s+(?:and|&|\/)\s+receiving\b|\b(?:shipping|receiving)\s+(?:clerk|associate|lead|supervisor|specialist|coordinator|manager)s?\b|\bshippers?\b/i,
    'logistics-warehouse',
    'shipping-receiving',
  ),
  R(
    /\b(?:warehouse|distribution\s+center|dc|fulfillment\s+center|logistics\s+center)\s+(?:manager|supervisor|director|operations\s+manager|shift\s+manager|team\s+lead|lead)s?\b|\bwarehouse\s+operations\b/i,
    'logistics-warehouse',
    'warehouse-management',
  ),
  R(
    /\b(?:truck|freight|fleet|load|delivery)\s+(?:dispatcher|planner)s?\b|\bdispatchers?\b|\bload\s+planners?\b|\btraffic\s+coordinators?\b|\bfreight\s+(?:broker|agent)s?\b/i,
    'logistics-warehouse',
    'dispatch-coordination',
  ),
  R(/\bwarehouse\b|\bdistribution\s+center\b|\bfulfillment\s+center\b/i, 'logistics-warehouse', 'warehouse-operations', true),

  // --- transportation and driving
  R(
    /\b(?:truck|semi|tractor[\s-]+trailer|otr|over[\s-]+the[\s-]+road|regional|local|long[\s-]+haul|line[\s-]+haul|tanker|flatbed|dump\s+truck|box\s+truck|freight|class\s+[ab])\s+(?:truck\s+)?drivers?\b|\bcdl\b|\btruckers?\b|\bowner[\s-]+operators?\b/i,
    'transportation',
    'truck-driving',
  ),
  R(
    /\b(?:delivery|courier|route|van|parcel|package|food\s+delivery|pizza\s+delivery)\s+(?:drivers?|associates?|helpers?|specialists?)\b|\bcouriers?\b/i,
    'transportation',
    'delivery-driving',
  ),
  R(
    /\b(?:bus|school\s+bus|transit|coach|motor\s?coach|shuttle|limo(?:usine)?|taxi|cab|rideshare|paratransit|passenger)\s+(?:drivers?|operators?)\b|\bchauffeurs?\b/i,
    'transportation',
    'passenger-transit',
  ),
  R(
    /\bpilots?\b(?!\s+(?:program|project))|\bfirst\s+officer\b|\bflight\s+(?:attendant|instructor|dispatcher|crew)s?\b|\bcabin\s+crew\b|\baircraft\s+(?:mechanic|technician|maintenance|inspector|fueler|cleaner)s?\b|\bairframe\s+and\s+powerplant\b|\bavionics\s+technician\b|\bair\s+traffic\s+controllers?\b|\bramp\s+(?:agent|associate|service)s?\b|\bbaggage\s+handlers?\b|\bgate\s+agents?\b/i,
    'transportation',
    'aviation',
  ),
  R(
    /\b(?:deck\s?hand|able\s+seaman|merchant\s+mariner|marine\s+(?:engineer|mechanic|technician)|tugboat|longshore(?:man|men|worker)?|stevedore|harbor\s+pilot)s?\b|\b(?:ship|boat)\s+(?:captain|mate|engineer|operator)s?\b|\b(?:train|rail(?:road|way)?|locomotive)\s+(?:conductor|engineer|operator|worker|carman|technician)s?\b|\bconductor\s+trainee\b|\bsignal\s+maintainer\b|\btrack\s+(?:laborer|worker|inspector)s?\b/i,
    'transportation',
    'maritime-rail',
  ),
  R(
    /\bfleet\s+(?:manager|coordinator|supervisor|maintenance|technician|mechanic|administrator)s?\b|\btransportation\s+(?:manager|supervisor|coordinator|planner|director)s?\b/i,
    'transportation',
    'fleet-management',
  ),
  R(/^(?!.*\b(?:device|kernel|graphics|gpu|usb)\b).*\bdrivers?\b/i, 'transportation', 'delivery-driving', true),

  // --- engineering outside software (before manufacturing and the trades: a welding engineer is an engineer)
  R(
    /\bmechanical\s+(?:design\s+)?(?:engineer|engineering|designer|drafter)s?\b|\b(?:hvac|thermal|piping|product\s+design)\s+engineers?\b|(?<!\b(?:ux|ui|web|visual|interaction|product)\s)\bdesign\s+engineers?\b/i,
    'engineering-physical',
    'mechanical-engineering',
  ),
  R(
    /\belectrical\s+(?:design\s+)?(?:engineer|engineering|designer)s?\b|\belectronics?\s+engineers?\b|\b(?:hardware|circuit|pcb|power\s+electronics|rf|analog|asic|fpga|controls?|instrumentation|power\s+systems?|protection|substation)\s+(?:design\s+)?engineers?\b/i,
    'engineering-physical',
    'electrical-engineering',
  ),
  R(
    /\b(?:civil|structural|geotechnical|transportation|traffic|water\s+resources|municipal|bridge|highway|land\s+development|site)\s+engineers?\b|\bcivil\s+engineering\b|\b(?:land\s+|quantity\s+)?surveyors?\b/i,
    'engineering-physical',
    'civil-structural',
  ),
  R(
    /\b(?:chemical|(?<!business\s)process|petroleum|plastics|polymer|materials|metallurgical|corrosion|packaging)\s+engineers?\b|\bchemical\s+engineering\b/i,
    'engineering-physical',
    'chemical-process',
  ),
  R(
    /\b(?:manufacturing|industrial|tooling|lean|continuous\s+improvement|plant)\s+engineers?\b|\b(?:industrial|manufacturing)\s+engineering\b/i,
    'engineering-physical',
    'industrial-manufacturing-engineering',
  ),
  R(
    /\b(?:aerospace|aeronautical|astronautical|propulsion|avionics|flight\s+test|spacecraft|satellite|aerodynamics|gnc)\s+engineers?\b/i,
    'engineering-physical',
    'aerospace-engineering',
  ),
  R(/\benvironmental\s+(?:engineer|engineering)s?\b|\b(?:water|wastewater|stormwater)\s+engineers?\b/i, 'engineering-physical', 'environmental-engineering'),
  R(
    /\bbiomedical\s+(?:engineer|engineering|equipment\s+technician|technician)s?\b|\bmedical\s+device\s+engineers?\b|\bclinical\s+engineers?\b/i,
    'engineering-physical',
    'biomedical-engineering',
  ),
  R(
    /^(?!.*\b(?:test|testing|automation|qa|selenium|cypress|playwright)\b).*\b(?:quality|(?<!site\s)reliability|supplier\s+quality|manufacturing\s+quality|product\s+quality)\s+engineers?\b/i,
    'engineering-physical',
    'quality-engineering',
  ),
  R(
    /\bdrafters?\b|\bdraftsm[ae]n\b|\bdraftspersons?\b|\bcad\s+(?:designer|technician|drafter|operator|specialist|manager)s?\b|\bautocad\b|\bbim\s+(?:modeler|coordinator|manager|specialist)s?\b|\brevit\b/i,
    'engineering-physical',
    'drafting-cad',
  ),
  R(
    /\bengineering\s+(?:technician|tech|aide)s?\b|\bproject\s+engineers?\b|\bfacilities\s+engineers?\b|\b(?:nuclear|mining|agricultural|safety|fire\s+protection)\s+engineers?\b/i,
    'engineering-physical',
    null,
    true,
  ),

  // --- manufacturing and production
  R(
    /\bproduction\s+(?:worker|associate|operator|technician|team\s+member|line\s+worker|helper|labou?rer|employee)s?\b|\bassemblers?\b|\bassembly\s+(?:worker|associate|technician|operator|line|team\s+member)s?\b|\bline\s+(?:worker|operator)s?\b|\bpackag(?:ing|er)\s+(?:operator|associate|worker|technician)s?\b|\bmanufacturing\s+(?:associate|technician|operator|worker|specialist|team\s+member)s?\b|\bfactory\s+(?:worker|associate)s?\b|\bprocess\s+technicians?\b|\bbatch\s+(?:maker|operator)s?\b|\bsewing\s+machine\s+operators?\b/i,
    'manufacturing',
    'production-assembly',
  ),
  R(
    /\bmachinists?\b|\bcnc\b|\b(?:machine|press|lathe|mill|extrusion|injection\s+mold(?:ing)?|molding|stamping|printing\s+press|saw|grinder|punch\s+press|brake\s+press)\s+(?:operator|setter|set-?up|technician|tech|helper)s?\b|\btool\s+and\s+die\b|\btool\s?makers?\b|\bset-?up\s+(?:operator|technician)s?\b|\bmold\s+(?:maker|technician)s?\b/i,
    'manufacturing',
    'machine-operation',
  ),
  R(
    /\b(?:quality\s+control|quality\s+assurance|qc|qa|quality)\s+(?:inspector|auditor|checker|technician|tech|associate|lab\s+technician)s?\b|\bquality\s+control\b|\bqc\b|\bquality\s+inspection\b|\bmetrologists?\b|\bcmm\s+(?:operator|inspector)s?\b|\bndt\s+(?:technician|inspector)s?\b/i,
    'manufacturing',
    'quality-control',
  ),
  R(
    /\b(?:industrial|plant|manufacturing|production|equipment)\s+maintenance\b|\bmaintenance\s+(?:mechanic|millwright)s?\b|\bmillwrights?\b|\bplc\s+technicians?\b|\binstrumentation\s+technicians?\b|\breliability\s+technicians?\b/i,
    'manufacturing',
    'industrial-maintenance',
  ),
  R(
    /\bproduction\s+(?:supervisor|manager|lead|planner|scheduler|control)s?\b|\bplant\s+(?:manager|supervisor|director|operations\s+manager)s?\b|\bmanufacturing\s+(?:supervisor|manager|planner|director|lead)s?\b|\bmaterials?\s+planners?\b|\bmaster\s+schedulers?\b/i,
    'manufacturing',
    'production-supervision',
  ),

  // --- skilled trades
  R(
    /\belectricians?\b|\belectrical\s+(?:apprentice|helper|technician|tech|foreman|installer|contractor|worker|journeyman|mechanic)s?\b|\bjourneym[ae]n\s+(?:electrician|wireman)\b|\binside\s+wireman\b|\blow\s+voltage\s+(?:technician|installer)s?\b|\belectronics?\s+(?:technician|tech)s?\b/i,
    'skilled-trades',
    'electrical',
  ),
  R(/\bplumb(?:er|ers|ing)\b|\b(?:pipe|steam|sprinkler|gas)\s?fitters?\b/i, 'skilled-trades', 'plumbing-pipefitting'),
  R(
    /\bhvac(?:\/?r)?\b|\bheating\s+(?:and|&)\s+(?:air|cooling)\b|\brefrigeration\s+(?:technician|tech|mechanic)s?\b|\bboiler\s+(?:operator|technician|mechanic)s?\b|\bchiller\s+technicians?\b/i,
    'skilled-trades',
    'hvac',
  ),
  R(
    /\bcarpenters?\b|\bconstruction\s+(?:worker|labou?rer|helper|apprentice|technician)s?\b|\b(?:drywall(?:er)?|framers?|framing|roofers?|roofing|masons?|masonry|bricklayers?|concrete\s+(?:finisher|worker)s?|iron\s?workers?|glaziers?|insulators?|tile\s+setters?|flooring\s+installers?|painters?|cabinet\s?makers?|millwork|scaffold(?:er|ers|ing))\b|\bgeneral\s+contractor\b|\bhandym[ae]n\b|\bhandy\s?persons?\b/i,
    'skilled-trades',
    'carpentry-construction',
  ),
  R(/\bwelders?\b|\bwelding\b|\bfabricators?\b|\bmetal\s+fabrication\b|\bsheet\s+metal\b|\bboilermakers?\b|\bbrazers?\b/i, 'skilled-trades', 'welding-fabrication'),
  R(
    /\b(?:auto(?:motive)?|car|vehicle|diesel|truck|heavy\s+equipment|small\s+engine|motorcycle|tire|lube|collision|body\s+shop)\s+(?:mechanic|technician|tech|repair\s+technician|service\s+technician)s?\b|\bauto\s+body\b|\bcollision\s+repair\b|\btire\s+(?:changer|technician)s?\b|\bdiesel\b/i,
    'skilled-trades',
    'automotive-mechanics',
  ),
  R(
    /\bfield\s+(?:service\s+(?:engineer|representative|specialist)|(?:service\s+)?(?:technician|tech|mechanic))s?\b|\bservice\s+(?:technician|tech)s?\b|\binstallation\s+(?:technician|tech)s?\b|\b(?:cable|satellite|alarm|fire\s+alarm|security\s+system|garage\s+door|appliance|elevator|telecom(?:munications)?|fiber)\s+(?:installer|technician|tech|repair\s+technician|mechanic)s?\b|\bappliance\s+repair\b|\blocksmiths?\b/i,
    'skilled-trades',
    'field-service',
  ),
  R(
    /\bconstruction\s+(?:manager|project\s+manager|superintendent|supervisor|foreman|coordinator|estimator|inspector|director)s?\b|(?<!\bbuilding\s)\bsuperintendents?\b|\bforem[ae]n\b|\bestimators?\b|\b(?:building|construction|code|home|electrical|plumbing)\s+inspectors?\b|\bpre-?construction\b/i,
    'skilled-trades',
    'construction-supervision',
  ),
  R(
    /\bheavy\s+equipment\s+(?:operator|mechanic|technician)s?\b|\b(?:crane|excavator|bulldozer|dozer|backhoe|grader|paver|roller)\s+operators?\b|\bequipment\s+operators?\b/i,
    'skilled-trades',
    'heavy-equipment',
  ),

  // --- facilities and maintenance
  R(
    /\bjanitors?\b|\bjanitorial\b|\bcustodians?\b|\bcustodial\b|\bcleaners?\b|\bcleaning\s+(?:technician|associate|specialist|crew|staff|attendant)s?\b|\benvironmental\s+services\s+(?:aide|technician|worker|associate|attendant)s?\b|\bevs\s+(?:aide|technician|tech)s?\b|\bporters?\b|\bsanitation\s+(?:worker|technician)s?\b/i,
    'facilities-services',
    'janitorial-custodial',
  ),
  R(
    /\bmaintenance\s+(?:technician|tech|worker|person|associate|helper|supervisor|manager|coordinator|engineer|lead)s?\b|\bbuilding\s+(?:engineer|maintenance|superintendent|operator)s?\b|\bstationary\s+engineers?\b|\b(?:property|apartment)\s+maintenance\b|\bpest\s+control\b|\bexterminators?\b/i,
    'facilities-services',
    'building-maintenance',
  ),
  R(
    /\blandscap(?:er|ers|ing)\b(?!\s+(?:architect|designer|design))|\bgroundskeepers?\b|\bgrounds\s+(?:keeper|maintenance|worker|crew|technician|supervisor)s?\b|\blawn\s+(?:care|technician)\b|\bgardeners?\b|\bhorticultur(?:ist|e)\b|\barborists?\b|\btree\s+(?:trimmer|climber)s?\b|\birrigation\s+technicians?\b/i,
    'facilities-services',
    'landscaping-grounds',
  ),
  R(
    /\bfacilit(?:y|ies)\s+(?:manager|coordinator|director|supervisor|technician|tech|specialist|assistant|operations|management|maintenance)s?\b/i,
    'facilities-services',
    'facilities-management',
  ),

  // --- agriculture, energy and the environment
  R(
    /\bfarm(?:er|ers|hand|hands)\b|\bfarm\s+(?:worker|hand|manager|labou?rer|technician|operations)s?\b|\bagricultur(?:al|e)\s+(?:worker|technician|labou?rer|specialist|manager)s?\b|\branch\s+hands?\b|\branchers?\b|\bharvest(?:er|ing)?\s+(?:worker|crew|hand)s?\b|\bgreenhouse\s+(?:worker|grower|technician|manager)s?\b|\bgrowers?\b|\bdairy\s+(?:worker|farm)\b|\blivestock\b|\bagronomists?\b|\bcrop\s+(?:advisor|scout|specialist)s?\b|\bfield\s+(?:worker|hand)s?\b|\bvineyard\b|\borchard\b|\bpoultry\b/i,
    'agriculture-energy',
    'farming-agriculture',
  ),
  R(
    /\bforest(?:er|ers|ry)\b|\bpark\s+rangers?\b|\bconservation\s+(?:officer|technician|specialist|scientist|worker)s?\b|\bwildlife\s+(?:biologist|technician|specialist)s?\b|\bnatural\s+resources?\s+(?:specialist|technician|manager)s?\b/i,
    'agriculture-energy',
    'forestry-conservation',
  ),
  R(
    /\blinem[ae]n\b|\bline\s?workers?\b(?=.*\b(?:power|electric|utility|distribution|transmission|journeyman)\b)|\blineworkers?\b|\b(?:power\s+plant|water\s+treatment|wastewater(?:\s+treatment)?|water|utility|substation|nuclear|control\s+room|gas\s+plant|treatment\s+plant)\s+operators?\b|\butility\s+(?:worker|technician|locator|crew)s?\b|\bmeter\s+(?:reader|technician)s?\b|\bwater\s+(?:distribution|treatment)\s+(?:technician|worker)s?\b/i,
    'agriculture-energy',
    'utilities-operations',
  ),
  R(
    /\boil\s+(?:and|&)\s+gas\b|\b(?:oil\s?field|rig|drilling|well|refinery|mine|mining|underground)\s+(?:worker|operator|hand|technician|supervisor|labou?rer|engineer|helper)s?\b|\bpipeline\s+(?:welder|inspector|operator|technician|labou?rer)s?\b|\broustabouts?\b|\broughnecks?\b|\bderrickhands?\b|\bfloorhands?\b|\bminers?\b|\bdrillers?\b|\bpumpers?\b/i,
    'agriculture-energy',
    'oil-gas-mining',
  ),
  R(
    /\bsolar\s+(?:installer|technician|panel\s+installer|pv\s+installer|energy\s+technician|field\s+technician)s?\b|\bwind\s+(?:turbine\s+)?(?:technician|tech)s?\b|\bpv\s+installers?\b|\bbattery\s+storage\s+technicians?\b|\brenewable\s+energy\s+technicians?\b/i,
    'agriculture-energy',
    'renewable-energy',
  ),

  // --- science and research (before v3.2's AI research rule: a research scientist with no AI or data word is a
  // scientist; "Research Scientist, Robotics" and "Applied Scientist" stay as v3.2 read them)
  R(
    /\bclinical\s+(?:research|trials?|study|studies)(?:\s+(?:coordinator|associate|assistant|manager|specialist|monitor|scientist|director))?\b|\b(?:cra|crc)\b|\bclinical\s+data\s+(?:manager|coordinator)s?\b|\bregulatory\s+affairs\b/i,
    'science-research',
    'clinical-research',
  ),
  R(
    /^(?!.*\b(?:equity|investment|market|ux|user|policy|credit|sales|clinical)\b).*(?:\b(?:lab(?:oratory)?|research)\s+(?:technician|tech|assistant|associate|aide|manager|coordinator|specialist)s?\b)/i,
    'science-research',
    'lab-research',
  ),
  R(/\bchemists?\b|\bchemistry\s+(?:technician|lab)\b/i, 'science-research', 'chemistry'),
  R(
    /(?<!computational\s)\b(?:micro|molecular\s+|cell\s+|marine\s+)?biologists?\b|\bbiochemists?\b|\bgeneticists?\b|\bimmunologists?\b|\bneuroscientists?\b|\bpharmacologists?\b|\btoxicologists?\b|\bbiotechnologists?\b|\bzoologists?\b|\becologists?\b|\bbotanists?\b|\bentomologists?\b|\bepidemiologists?\b/i,
    'science-research',
    'life-sciences',
  ),
  R(
    /\benvironmental\s+(?:scientist|specialist|technician|consultant|analyst|coordinator)s?\b|\b(?:geologists?|hydrologists?|geoscientists?|geophysicists?|meteorologists?|climatologists?|oceanographers?|soil\s+scientists?|seismologists?)\b|\bindustrial\s+hygienists?\b/i,
    'science-research',
    'environmental-science',
  ),
  R(/\bphysicists?\b|\bmaterials\s+scientists?\b|\bastronomers?\b|\bmathematicians?\b|\boptical\s+scientists?\b/i, 'science-research', 'physical-sciences'),
  R(
    /^(?!.*\b(?:data|decision|applied|nlp|computer\s+vision|vision|speech|language|robotics|perception|recommend\w*|search|quant\w*|bioinformatic\w*|computational|statistic\w*)\b).*\bscientists?\b/i,
    'science-research',
    null,
    true,
  ),

  // --- writing, media and communications
  R(/\bcontent\s+writers?\b/i, 'writing-media', null), // v33 FIX-1: the writing-media pack's own example title (v3.2: marketing)
  R(
    /\bjournalists?\b|\breporters?\b|\bcorrespondents?\b|\bnews\s+(?:writer|editor|producer|anchor|reporter)s?\b|\bcolumnists?\b|\bnewsroom\b/i,
    'writing-media',
    'journalism',
  ),
  R(
    /\bcopy\s?editors?\b|\bproofreaders?\b|\bmanaging\s+editors?\b|\beditor[\s-]+in[\s-]+chief\b|\bpublishing\s+(?:assistant|coordinator|manager)s?\b|\bliterary\s+agents?\b/i,
    'writing-media',
    'editing-publishing',
  ),
  R(
    /\bvideo\s+(?:editor|producer|production|journalist|specialist|creator|coordinator)s?\b|\bvideographers?\b|\bfilm\s?(?:editor|maker|producer|director|crew)s?\b|\bcamera\s+(?:operator|assistant)s?\b|\bcinematographers?\b|\bbroadcast\s+(?:engineer|technician|producer|journalist|operator)s?\b|\b(?:tv|television|radio)\s+(?:producer|host|anchor|director|reporter)s?\b|\bproduction\s+assistants?\b|\bpost[\s-]?production\b|\bgaffers?\b|\bcolorists?\b/i,
    'writing-media',
    'video-film-broadcast',
  ),
  R(/\bphotographers?\b|\bphotography\b|\bphoto\s+(?:editor|retoucher|assistant|studio)s?\b|\bretouchers?\b/i, 'writing-media', 'photography'),
  R(
    /\billustrators?\b|\banimators?\b|\banimation\b|\bstoryboard\s+artists?\b|\bconcept\s+artists?\b|\b(?:2d|3d)\s+artists?\b|\bcharacter\s+artists?\b|\bcomic\s+artists?\b/i,
    'writing-media',
    'illustration-animation',
  ),
  R(
    /\btranslators?\b|\binterpreters?\b|\btranslation\s+(?:specialist|coordinator|manager)s?\b|\bsign\s+language\b|\btranscribers?\b|\bcaptioners?\b|\bsubtitlers?\b/i,
    'writing-media',
    'translation-interpreting',
  ),
  R(
    /\b(?:audio|sound|recording|mixing|mastering|live\s+sound|music)\s+(?:engineer|technician|tech|producer|designer|editor|mixer)s?\b|\bmusicians?\b|\bcomposers?\b|\bsongwriters?\b|\bdj\b|\bvocalists?\b|\bsingers?\b|\bpodcast\s+(?:producer|host|editor)s?\b|\bvoice\s+(?:actor|over\s+artist)s?\b/i,
    'writing-media',
    'audio-music',
  ),
  R(/\beditors?\b/i, 'writing-media', 'editing-publishing', true),
  R(/\bproducers?\b/i, 'writing-media', 'video-film-broadcast', true),

  // --- real estate
  R(
    /\breal\s?estate\s+(?:agent|broker|salesperson|associate|advisor|consultant|sales|specialist)s?\b|\brealtors?\b|\b(?:listing|buyer['’]?s?)\s+agents?\b|\brealty\b|\bbroker\s+associates?\b/i,
    'real-estate',
    'real-estate-sales',
  ),
  R(
    /\b(?:property|apartment|leasing|residential|hoa|commercial\s+property)\s+(?:manager|management|coordinator|assistant|administrator|consultant|specialist|agent|director)s?\b|\bleasing\s+(?:agent|consultant|professional|specialist|associate|manager)s?\b|\bresident\s+(?:services|manager)\b/i,
    'real-estate',
    'property-management',
  ),
  R(
    /\bappraisers?\b|\btitle\s+(?:examiner|officer|agent|processor|insurance)s?\b|\bescrow\s+(?:officer|assistant|coordinator|agent)s?\b/i,
    'real-estate',
    'real-estate-appraisal',
  ),

  // --- social services and the public sector
  R(
    /\bsocial\s+workers?\b|\bsocial\s+work\b|\bcase\s?(?:manager|worker|management)s?\b|\b(?:lcsw|lmsw|msw)\b|\bfamily\s+(?:advocate|support\s+(?:worker|specialist))s?\b|\bchild\s+(?:welfare|protective\s+services)\b|\bhousing\s+(?:case\s+manager|specialist|navigator|coordinator)s?\b|\bbenefits\s+navigators?\b/i,
    'social-public-sector',
    'social-work',
  ),
  R(
    /\bcommunity\s+(?:outreach|health\s+workers?|organizers?|liaisons?|engagement\s+(?:coordinator|specialist)|program\s+(?:coordinator|manager)|services|educators?)\b|\boutreach\s+(?:worker|coordinator|specialist)s?\b|\byouth\s+(?:worker|counselor|program|mentor|development|specialist|coordinator|leader)s?\b|\bcamp\s+counselors?\b|\brecreation\s+(?:aide|leader|coordinator|specialist|assistant)s?\b|\bafter[\s-]?school\b|\bvolunteer\s+(?:coordinator|manager)s?\b|\bresidential\s+(?:counselor|advisor|aide)s?\b|\bshelter\s+(?:advocate|staff|worker)s?\b/i,
    'social-public-sector',
    'community-outreach',
  ),
  R(
    /\bpolicy\s+(?:analyst|advisor|adviser|associate|fellow|director)s?\b|\blegislative\s+(?:aide|assistant|analyst|director)s?\b|\b(?:city|urban|regional|land\s+use)\s+planners?\b|\bcity\s+(?:manager|clerk)\b|\bcounty\s+(?:clerk|administrator)\b|\bmunicipal\s+(?:clerk|administrator|manager)\b|\bpublic\s+(?:administration|affairs\s+(?:specialist|officer))\b|\bgovernment\s+affairs\b|\bcode\s+enforcement\b|\b(?:health|food\s+safety|environmental\s+health)\s+inspectors?\b|\belection\s+(?:worker|official)s?\b|\bpostal\s+(?:worker|carrier|clerk)s?\b|\bmail\s+carriers?\b/i,
    'social-public-sector',
    'public-administration',
  ),
  R(
    /\bfundrais\w*|\bdevelopment\s+officers?\b|\bgrants?\s+(?:writer|manager|coordinator|specialist|administrator|officer)s?\b|\b(?:major|planned|annual)\s+gifts?\b|\bannual\s+fund\b|\bdonor\s+(?:relations|engagement|stewardship)\b|\bphilanthropy\b|\bprogram\s+officers?\b/i,
    'social-public-sector',
    'nonprofit-fundraising',
  ),
  R(
    /\blibrarians?\b|\blibrary\s+(?:assistant|technician|associate|clerk|aide|page|director|manager|specialist)s?\b|\barchivists?\b|\bcurators?\b|\bmuseum\s+(?:educator|technician|assistant|curator|registrar)s?\b|\bdocents?\b/i,
    'social-public-sector',
    'library-archives',
  ),
];

/** After every v3.2 rule: the bare role nouns a v3.2 rule may name more precisely first ("Accounts Payable Clerk"). */
export const FIELD_CATCH_ALLS: readonly FieldTitleRule[] = [
  R(/\bclerks?\b/i, 'administrative-office', 'office-clerical', true),
  R(/\bwriters?\b/i, 'writing-media', null, true),
  R(/\binstructors?\b/i, 'education', 'tutoring-instruction', true),
  R(/^(?!.*\b(?:career|admissions?|financial|camp|sales|loan|guidance|legal)\b).*\bcounsel(?:l)?ors?\b/i, 'healthcare', 'behavioral-health', true),
  R(/\baides?\b/i, 'healthcare', 'nursing-assistant', true),
  R(/\blabou?rers?\b|\bgeneral\s+labou?r\b/i, 'skilled-trades', 'carpentry-construction', true),
  R(/\bmechanic\b/i, 'skilled-trades', 'automotive-mechanics', true),
  R(/\binstallers?\b/i, 'skilled-trades', 'field-service', true),
  R(/(?<!\b(?:computer|network|noc|systems|data)\s)\boperators?\b/i, 'manufacturing', 'machine-operation', true),
  R(/\binspectors?\b/i, 'manufacturing', 'quality-control', true),
  R(/\bhandlers?\b/i, 'logistics-warehouse', 'material-handling', true),
  // v33 FIX-1: a shift supervisor named by nothing else runs a store's or a cafe's shift (a warehouse's, a plant's or a
  // security team's is named by the rules above).
  R(/^(?!.*\b(?:production|manufacturing|plant|factory|warehouse|distribution|logistics|security|hospital|nursing)\b).*\bshift\s+(?:supervisor|lead|leader)s?\b/i, 'retail', 'store-management', true),
];
