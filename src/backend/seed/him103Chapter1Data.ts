import { CreateExamInput, UpsertQuestionInput } from '../types/domain.ts';

export const HIM103_CH1_METADATA: CreateExamInput = {
  title: 'HIM 103 Chapter 1',
  description:
    'Assessment on HIM 103 Chapter 1: definitions and models of health, health systems and their building blocks, healthcare financing models, tiers of care, and hospital classification and functions.',
  instructions:
    'This quiz contains 40 multiple-choice questions allocated for 40 minutes. Answer one question at a time in order, or use the Question Navigator pane to jump directly to any question. When the 40 minutes are up, your attempt is submitted automatically. Once you submit, your score, correct answers, and detailed explanations are available for review.',
  duration_minutes: 40,
  passing_percentage: 50,
  result_release_policy: 'immediate',
  allow_review: true,
  shuffle_questions: false,
  shuffle_options: false,
  max_attempts: 100,
  retake_cooldown_minutes: 180,
  open_to_all: true,
  is_open: true,
};

interface RawQ {
  q: string;
  o: string[];
  a: 'A' | 'B' | 'C' | 'D' | 'E';
  e: string;
}

const RAW: RawQ[] = [
  {
    q: `According to the World Health Organization (WHO, 1948) definition, which of the following best describes health?`,
    o: [
      `The complete absence of physical or mental pathogens in an individual`,
      `A state of complete physical, mental, and social well-being, and not merely the absence of disease or infirmity`,
      `The dynamic capacity of an individual to carry out daily activities and achieve longevity`,
      `A functional state where biological organs operate without mechanical malfunction`,
    ],
    a: 'B',
    e: `The World Health Organization (1948) explicitly defines health as a state of complete physical, mental, and social well-being, and not merely the absence of disease or infirmity.`,
  },
  {
    q: `How does a health system fundamentally differ from a mechanical system such as an automobile?`,
    o: [
      `Mechanical systems possess adaptable elements that learn from within, whereas health systems are entirely predictable.`,
      `Mechanical systems have components that interact nonlinearly, whereas health systems feature linear component interactions.`,
      `Health systems are complex adaptive systems whose outputs can be unpredictable and dynamic, whereas mechanical systems produce predictable outputs in response to given stimuli.`,
      `Health systems rely on central control to maintain absolute order, whereas mechanical systems self-organize without external management.`,
    ],
    a: 'C',
    e: `Mechanical systems (like an automobile) have components that interact linearly to produce predictable outputs that can be controlled. Health systems are complex adaptive systems where components interact nonlinearly, producing dynamic, unpredictable outputs.`,
  },
  {
    q: `Which of the following best characterizes the characteristics of a health system?`,
    o: [
      `Adaptable elements, context, inherent order, and unpredictability`,
      `Fixed structures, strict linearity, centralized command, and guaranteed predictability`,
      `Standalone operations, isolated variables, absolute optimization of every single part, and static outputs`,
      `Mechanical predictability, external imposition of change, absence of internal learning, and isolated components`,
    ],
    a: 'A',
    e: `Health systems possess four key characteristics: adaptable elements, context, inherent order, and unpredictability.`,
  },
  {
    q: `Which of the following statements regarding a healthcare system (HCS) is/are correct?\nI. It is a network of organizations, resources, personnel, and technologies.\nII. Its primary purpose includes delivering preventive, promotive, and curative health services fairly and equitably without discrimination.\nIII. It operates strictly as a profit-driven competitive market where consumers possess superior knowledge compared to providers.`,
    o: [`I only`, `II only`, `Both I and II`, `Both I and III`, `I, II, and III`],
    a: 'C',
    e: `Statements I and II are correct: a healthcare system is a network of organizations and resources designed to deliver preventive, promotive, and curative services fairly and equitably. Statement III is incorrect because healthcare is not a typical competitive market and consumers possess less knowledge than providers.`,
  },
  {
    q: `What are the three overall goals of a national health system as identified in the lecture?`,
    o: [
      `Maximum profitability, market dominance, and technological advancement`,
      `Good health (goodness and fairness), responsiveness to population expectations, and fairness without discrimination`,
      `Complete eradication of all chronic diseases, universal hospital admission, and centralized administrative control`,
      `Individual medical self-sufficiency, private insurance coverage for all citizens, and biomedical standardization`,
    ],
    a: 'B',
    e: `The three overall goals of a national health system are good health (goodness and fairness), responsiveness to population expectations, and fairness without discrimination.`,
  },
  {
    q: `Which of the following represent the WHO's six building blocks of a health system?`,
    o: [
      `Service delivery, health workforce, health information, medical products/vaccines/technologies, financing, and leadership/governance`,
      `Primary care, secondary care, tertiary care, quaternary care, self-care, and community health stations`,
      `Preventive services, promotive services, curative services, diagnostic services, therapeutic services, and palliative services`,
      `Beveridge funding, Bismarck funding, private insurance, out-of-pocket payment, tiered delivery, and diffuse delivery`,
    ],
    a: 'A',
    e: `WHO describes health systems as having six building blocks: service delivery, health workforce, information, medical products/vaccines/technologies, financing, and leadership and governance.`,
  },
  {
    q: `Which of the following statements correctly describe the philosophy of the healthcare delivery system?\nI. Everyone from birth to death is part of the market potential for healthcare services.\nII. The consumer of health services is regarded as a client rather than an ordinary customer.\nIII. Consumers possess superior and comprehensive technical knowledge about health services compared to healthcare professionals.`,
    o: [`I and II only`, `II and III only`, `Both I and III`, `I, II, and III`, `None of the above`],
    a: 'A',
    e: `Statements I and II are correct: everyone is part of the market potential, and consumers are regarded as clients rather than ordinary customers. Statement III is incorrect because consumers are actually less informed about health services than professionals.`,
  },
  {
    q: `When health is viewed as a "consumption good," which of the following best describes its primary role?`,
    o: [
      `It increases labor productivity and reduces working days lost to illness.`,
      `It yields direct satisfaction and utility, and can be purchased to improve quality of life.`,
      `It functions strictly as a fundamental human right analogous to political freedom.`,
      `It guarantees that healthcare markets operate with unrestricted, perfect economic competition.`,
    ],
    a: 'B',
    e: `When viewed as a consumption good, health and healthcare yield direct satisfaction and utility, and can be purchased to improve quality of life.`,
  },
  {
    q: `How does the "investment" perspective of health differ from the "consumption good" perspective?`,
    o: [
      `The investment perspective focuses on how better health increases labor productivity and reduces absenteeism, whereas consumption focuses on direct satisfaction and quality of life.`,
      `The investment perspective views health purely as a legal entitlement, whereas consumption views it through the biomedical germ theory.`,
      `The investment perspective relies entirely on out-of-pocket financing, whereas consumption relies on the Bismarck model.`,
      `There is no difference; both perspectives treat health exclusively as an inpatient hospital service.`,
    ],
    a: 'A',
    e: `The investment perspective focuses on the relationship between health and labor productivity (e.g., fewer sick days), whereas the consumption good perspective focuses on direct satisfaction and quality of life.`,
  },
  {
    q: `The positive model of health is divided into two major approaches: health as a state and health as a capacity. Which charter or organization is associated with defining health as a "capacity" or resource for doing things?`,
    o: [
      `The World Health Organization (WHO, 1948)`,
      `The Ottawa Charter`,
      `The Beveridge Commission`,
      `The Bismarck Social Insurance Act`,
    ],
    a: 'B',
    e: `The Ottawa Charter defined health in terms of capacity, or as a resource for doing things, rather than a fixed state of well-being.`,
  },
  {
    q: `Which of the following are recognized limitations of the WHO definition of health as a state of complete well-being?\nI. It is considered too idealistic and unattainable.\nII. It is all-embracing, undifferentiated, and classifies a vast majority of healthy people as unhealthy.\nIII. It relies solely on objective scientific investigations and completely ignores how individuals feel.`,
    o: [`I and II only`, `II and III only`, `Both I and III`, `I, II, and III`, `I only`],
    a: 'A',
    e: `Statements I and II correctly identify the limitations of the WHO definition (too idealistic/unattainable and all-embracing/undifferentiated). Statement III describes the negative model, not a limitation of the WHO definition.`,
  },
  {
    q: `Which of the following statements accurately contrasts the positive model of health with the negative model of health?`,
    o: [
      `The positive model focuses on the absence of disease, whereas the negative model focuses on complete social well-being.`,
      `The positive model relies strictly on objective scientific investigations, whereas the negative model incorporates subjective patient feelings.`,
      `The positive model focuses on well-being and health-promoting factors, whereas the negative model defines health as the polar opposite of disease (absence of illness) based on objective evidence.`,
      `The positive model is exclusively applied in acute hospital settings, whereas the negative model is applied exclusively in community health promotion.`,
    ],
    a: 'C',
    e: `The positive model focuses on well-being and health-promoting factors, whereas the negative model defines health as the absence of disease based on objective scientific evidence regardless of subjective feelings.`,
  },
  {
    q: `The biomedical model of health is closely linked to which of the following concepts?`,
    o: [
      `The Ottawa Charter and the social determinants of health`,
      `Germ theory and the doctrine of specific aetiology (that every disease has a single, isolated cause)`,
      `The Beveridge taxation funding model and universal public service`,
      `Diffuse healthcare delivery systems and direct specialist access`,
    ],
    a: 'B',
    e: `The biomedical model is closely linked to germ theory, which gave rise to the doctrine of specific aetiology (that every disease has a single, observable, isolatable cause).`,
  },
  {
    q: `Which of the following are noted weaknesses or criticisms of the biomedical model of health?\nI. Not everyone exposed to a specific causative agent develops the disease.\nII. Many diseases involve multiple contributing causative factors rather than a single isolated cause.\nIII. It completely ignores biological microorganisms and relies entirely on social housing conditions.`,
    o: [`I and II only`, `II and III only`, `Both I and III`, `I, II, and III`, `I only`],
    a: 'A',
    e: `Statements I and II are recognized weaknesses of the biomedical model: not everyone exposed to a causative agent develops disease, and many conditions have multiple contributing causes. Statement III is incorrect.`,
  },
  {
    q: `How does the social model of health view the primary responsibility for ill-health and health promotion?`,
    o: [
      `It views ill-health strictly as an unpredictable "act of God" with no human accountability.`,
      `It views health as the result of interacting social, economic, environmental, and personal factors, placing collective responsibility on society as a whole.`,
      `It restricts healthcare responsibility entirely to individual genetic makeup and biomedical surgical interventions.`,
      `It relies solely on private medical insurance companies to regulate environmental living conditions.`,
    ],
    a: 'B',
    e: `The social model views health as the result of interacting social, economic, environmental, and personal factors, placing collective responsibility on society as a whole.`,
  },
  {
    q: `Which of the following health models are closely associated with a prioritized approach toward disease prevention?`,
    o: [
      `The negative model and the biomedical model`,
      `The curative model and the out-of-pocket model`,
      `The positive model and the social model`,
      `The private insurance model and the diffuse delivery model`,
    ],
    a: 'C',
    e: `The positive and social models of health are more likely to lead to an approach to healthcare where top priority is given to prevention.`,
  },
  {
    q: `Which of the following are key characteristics and approaches of the preventive model of healthcare?\nI. Promoting "healthy public policy" to make healthy choices the easier choices.\nII. Mobilizing a wide range of agencies such as academic institutions, voluntary organizations, and local authorities.\nIII. Relying exclusively on high-tech inpatient hospital surgeries as the primary location of care.`,
    o: [`I and II only`, `II and III only`, `Both I and III`, `I, II, and III`, `I only`],
    a: 'A',
    e: `Statements I and II are core approaches of the preventive model (advocating healthy public policy and mobilizing diverse agencies). Statement III describes the curative model, not prevention.`,
  },
  {
    q: `What are some of the primary drawbacks associated with preventive healthcare models?`,
    o: [
      `Preventive strategies produce immediate, short-term outcomes that are too easy to measure and verify.`,
      `Outcomes take a long time to materialize, multi-agency collaboration is difficult to sustain, and expectations can be raised leading to disappointment if disease occurs despite healthy practices.`,
      `They cause high rates of iatrogenesis through excessive pharmaceutical drug interventions.`,
      `They eliminate the need for community health promotion and focus entirely on individual clinical cures.`,
    ],
    a: 'B',
    e: `Drawbacks of prevention include long-term outcomes with high uncertainty, difficulty sustaining multi-agency collaboration, and raised expectations leading to disappointment if illness occurs.`,
  },
  {
    q: `Which of the following best describes the financing and characteristics of the Beveridge Model?`,
    o: [
      `Financed mainly through mandatory social health insurance premiums jointly paid by employers and employees.`,
      `Financed predominantly through private insurance premiums paid by independent customers.`,
      `Financed mainly through taxation, operating as a centrally organized public service where providers may be government employees and medical bills are absent.`,
      `Financed entirely out-of-pocket by patients at the exact time of service without any government or insurance backing.`,
    ],
    a: 'C',
    e: `The Beveridge Model is financed mainly through taxation, operates as a centrally organized public service with government-employed providers, and features no direct medical bills.`,
  },
  {
    q: `Which national health system model was introduced by Otto von Bismarck in Germany in 1883 and relies on premium-financed social or mandatory sickness funds?`,
    o: [`The Beveridge Model`, `The Bismarck Model`, `The Private Insurance Model`, `The Out-of-Pocket Model`],
    a: 'B',
    e: `The Bismarck Model, introduced by Otto von Bismarck in Germany in 1883, is funded mainly by premium-financed mandatory social insurance ("sickness funds").`,
  },
  {
    q: `In which healthcare financing model do patients pay directly from their personal funds for care, with little to no insurance or government coverage, often leaving poorer individuals unable to obtain treatment?`,
    o: [`The Beveridge Model`, `The Bismarck Model`, `The Private Insurance Model`, `The Out-of-Pocket Model`],
    a: 'D',
    e: `In the out-of-pocket model, patients pay directly from their own personal funds with little to no insurance or government coverage, making care difficult for the poor.`,
  },
  {
    q: `How is a tiered healthcare delivery system structured according to the level of care and population administrative units?`,
    o: [
      `It is unstructured and diffuse, allowing patients to consult sub-specialists directly without restriction.`,
      `It is organized regionally into primary care (local communities, e.g., 2,000–50,000 inhabitants), secondary care (districts, 100,000–500,000 inhabitants), and tertiary care (regions, 500,000–5,000,000 inhabitants).`,
      `It is funded exclusively through private out-of-pocket payments managed by corporate hospital boards.`,
      `It relies entirely on self-care households of 1 to 10 persons without any formal professional medical referral networks.`,
    ],
    a: 'B',
    e: `A tiered system organizes care into primary care (local communities, 2,000–50,000 inhabitants), secondary care (districts, 100,000–500,000 inhabitants), and tertiary care (regions, 500,000–5,000,000 inhabitants).`,
  },
  {
    q: `Which of the following statements accurately describe secondary healthcare?\nI. It provides general specialist care (such as general surgeons, internal medicine specialists, gynecologists, and psychiatrists) for more complex conditions.\nII. The administrative unit is typically a district, serving a population size ranging from 100,000 to 500,000 inhabitants.\nIII. It represents the first point of contact for an individual entering the formal healthcare system.`,
    o: [`I and II only`, `II and III only`, `Both I and III`, `I, II, and III`, `I only`],
    a: 'A',
    e: `Statements I and II are correct: secondary care provides general specialist care within district administrative units serving 100,000 to 500,000 inhabitants. Statement III describes primary care, not secondary care.`,
  },
  {
    q: `What distinguishes tertiary care from primary and secondary care within a tiered healthcare delivery system?`,
    o: [
      `It focuses exclusively on health promotion campaigns and personal hygiene maintained within households.`,
      `It provides sub-specialist care (such as neurosurgeons, cardiologists, nephrologists, and plastic surgeons) delivered in highly specialized institutions.`,
      `It allows patients to bypass general practitioners entirely and approach specialized centers directly without referral.`,
      `It provides short-term acute care exclusively at local community health stations.`,
    ],
    a: 'B',
    e: `Tertiary care provides sub-specialist care (such as neurosurgeons and cardiologists) delivered in highly specialized institutions or regional centers.`,
  },
  {
    q: `What is quaternary care considered to be within the healthcare delivery system?`,
    o: [
      `An unorganized form of nonprofessional self-care performed within families.`,
      `An extension of tertiary care involving exceptionally specialized, uncommon, and experimental medical procedures.`,
      `The primary point of contact for routine immunizations and health education.`,
      `Basic outpatient diagnostic testing conducted in acute-care community hospitals.`,
    ],
    a: 'B',
    e: `Quaternary care is an extension of tertiary care involving exceptionally specialized, uncommon, and experimental medical procedures.`,
  },
  {
    q: `Which of the following best characterizes a diffuse healthcare delivery system?`,
    o: [
      `Healthcare is strictly divided into regionalized levels of primary, secondary, and tertiary care with mandatory referral pathways.`,
      `There is no strict divisional hierarchy; patients can directly approach specialists, boundaries between general practitioners and specialists are blurred, and it is relatively common in the United States.`,
      `Healthcare is fully funded through taxation under a government-managed National Health Service.`,
      `Care is restricted entirely to nonprofessional self-medication within households.`,
    ],
    a: 'B',
    e: `In a diffuse system, there is no strict tiered division, patients can approach specialists directly, boundaries between general practitioners and specialists are blurred, and it is common in the United States.`,
  },
  {
    q: `According to the World Health Organization (WHO) criteria, an establishment must meet which minimum requirements to be classified as a hospital?`,
    o: [
      `Staffed by at least one physician, offer inpatient accommodation, provide active medical and nursing care, and have at least six beds.`,
      `Staffed by at least ten physicians, offer outpatient services exclusively, and have at least fifty beds without overnight accommodation.`,
      `Operate strictly as a for-profit corporate entity providing quaternary experimental surgeries.`,
      `Focus exclusively on community-based health promotion and preventive vaccination campaigns.`,
    ],
    a: 'A',
    e: `According to WHO criteria, a hospital must be permanently staffed by at least one physician, offer inpatient accommodation, provide active medical and nursing care, and have at least six beds.`,
  },
  {
    q: `Hospitals can be classified according to length of stay into which of the following categories?`,
    o: [
      `General hospitals, special hospitals, and university hospitals`,
      `Acute-care hospitals (short-term), chronic-care hospitals (long-term), and day-care hospitals`,
      `For-profit, not-for-profit, and governmental hospitals`,
      `Primary health stations, district hospitals, and regional specialist centers`,
    ],
    a: 'B',
    e: `Hospitals are classified by length of stay into acute care (short-term), chronic care (long-term), and day-care hospitals.`,
  },
  {
    q: `How do general hospitals differ from special hospitals in terms of service classification?`,
    o: [
      `General hospitals provide a broad range of medical and surgical care (including paediatrics, obstetrics/gynecology, and ENT), whereas special hospitals focus on one specialty, a particular disease, or a specific group of diseases.`,
      `General hospitals provide exclusively long-term chronic care, whereas special hospitals provide acute day-care services.`,
      `General hospitals are strictly owned by religious organizations, whereas special hospitals are investor-owned for-profit entities.`,
      `General hospitals only provide quaternary experimental treatments, whereas special hospitals handle primary community contacts.`,
    ],
    a: 'A',
    e: `General hospitals provide a broad range of medical and surgical care, whereas special hospitals focus on one specialty, a particular disease, or a specific group of diseases.`,
  },
  {
    q: `Which of the following represent major functions performed by hospitals?\nI. Diagnosing and treating the sick and injured through outpatient or inpatient services.\nII. Preventing illness, promoting health, and educating patients on self-care after discharge.\nIII. Educating health services workers and conducting medical research (such as clinical trials and quality of care assessments).`,
    o: [`I and II only`, `II and III only`, `Both I and III`, `I, II, and III`, `I only`],
    a: 'D',
    e: `All three statements represent major functions of hospitals: diagnosing and treating patients, preventing illness and promoting health, and educating health workers and conducting research.`,
  },
  {
    q: `A public health team is analyzing why a community with high exposure to a specific bacterial pathogen does not experience uniform illness across all residents. This observation most directly challenges the absolute rigidity of which concept?`,
    o: [
      `The Ottawa Charter definition of health capacity`,
      `The doctrine of specific aetiology associated with the biomedical model`,
      `The Beveridge tax-funded healthcare model`,
      `The tiered secondary referral system`,
    ],
    a: 'B',
    e: `The observation that exposure to a pathogen does not uniformly cause disease directly challenges the doctrine of specific aetiology (the biomedical assumption that a single causative agent always results in a single disease).`,
  },
  {
    q: `A government ministry of health decides to restructure its national health financing so that all healthcare is funded directly through progressive national tax revenues, eliminating direct medical bills and employing providers directly as public servants. Which model is being implemented?`,
    o: [`The Bismarck Model`, `The Beveridge Model`, `The Private Insurance Model`, `The Out-of-Pocket Model`],
    a: 'B',
    e: `Financing healthcare through national taxation, eliminating direct medical bills, and using government-employed public providers defines the Beveridge Model.`,
  },
  {
    q: `A patient suffering from a complex congenital heart defect requires specialized surgical intervention that cannot be managed by a general practitioner or a district general surgeon. According to the tiered healthcare delivery model, to which level of care should this patient be referred?`,
    o: [`Primary healthcare level`, `Nonprofessional self-care level`, `Tertiary healthcare level`, `Community health station level`],
    a: 'C',
    e: `Complex congenital heart defects requiring sub-specialist surgical intervention fall under tertiary care, delivered by specialized institutions or cardiothoracic specialists.`,
  },
  {
    q: `A healthcare analyst reviewing a nation's health structure notes that patients frequently book appointments with cardiologists and dermatologists directly without consulting a primary care general practitioner, and hospital facilities provide an overlapping mix of multi-specialty services. This nation's delivery structure exemplifies:`,
    o: [
      `A strict regionalized tiered system`,
      `A diffuse healthcare delivery system`,
      `A pure Beveridge public service model`,
      `A primary-level community health station network`,
    ],
    a: 'B',
    e: `Direct access to specialists without GP referral, blurred practitioner boundaries, and multi-service hospital mixes are hallmarks of the diffuse healthcare system.`,
  },
  {
    q: `A local health facility is evaluated to determine whether it legally qualifies as a hospital under WHO guidelines. Investigators find it is permanently staffed by two physicians, provides active medical and nursing care, offers inpatient accommodation, and maintains eight operational beds. What is the correct conclusion?`,
    o: [
      `It qualifies as a hospital because it meets all minimum WHO criteria.`,
      `It does not qualify because it lacks a quaternary experimental research unit.`,
      `It does not qualify because hospitals must have a minimum of fifty beds.`,
      `It qualifies only if it operates under a private insurance funding model.`,
    ],
    a: 'A',
    e: `The facility meets all four WHO criteria: at least one physician (it has two), inpatient accommodation, active medical/nursing care, and at least six beds (it has eight).`,
  },
  {
    q: `An elderly patient is admitted to a facility for long-term rehabilitation following a severe stroke, requiring prolonged nursing support rather than short-term acute episodic intervention. How should this facility be classified according to length of stay?`,
    o: [`Acute-care hospital`, `Chronic-care hospital`, `Day-care hospital`, `Primary health station`],
    a: 'B',
    e: `Facilities providing long-term rehabilitation and prolonged care rather than short-term acute episodic intervention are classified as chronic-care hospitals.`,
  },
  {
    q: `A newly established medical center focuses entirely on orthopedic surgical operations and musculoskeletal deformity corrections, offering no other general medical specialties. Under hospital service classifications, how should this facility be categorized?`,
    o: [`General hospital`, `Special hospital`, `University teaching hospital`, `Community primary health center`],
    a: 'B',
    e: `Facilities that offer services in one medical or surgical specialty, or focus on a specific group of diseases, are classified as special hospitals.`,
  },
  {
    q: `A public health researcher argues that the primary determinants of a population's respiratory illness rates are substandard housing conditions, poverty, and overcrowding, rather than individual pathogen exposure alone. This perspective aligns most closely with:`,
    o: [
      `The biomedical model of health`,
      `The negative model of health`,
      `The social model of health`,
      `The curative model of healthcare`,
    ],
    a: 'C',
    e: `Emphasizing social, economic, and environmental living conditions (such as housing, poverty, and overcrowding) as the primary determinants of health is the defining characteristic of the social model of health.`,
  },
  {
    q: `A healthcare economist evaluates a system where healthcare financing is dominated by private insurance premiums paid by independent customers, with the vast majority of providers operating in the private sector. This system represents:`,
    o: [`The Bismarck Model`, `The Beveridge Model`, `The Private Insurance Model`, `The Out-of-Pocket Model`],
    a: 'C',
    e: `Systems funded predominantly through private insurance premiums paid into private companies, with private sector providers, represent the Private Insurance Model.`,
  },
  {
    q: `When examining the relationship between health models and healthcare delivery approaches, which of the following pairings correctly connects the foundational model to its predominant clinical orientation?`,
    o: [
      `Positive and social models lead primarily to a preventive approach; negative and biomedical models lead primarily to a curative approach.`,
      `Curative models lead primarily to community health promotion; preventive models lead exclusively to high-tech inpatient surgeries.`,
      `The out-of-pocket model leads exclusively to universal public service; the Beveridge model leads to direct out-of-pocket fees.`,
      `The diffuse delivery model leads strictly to primary health stations; the tiered model leads to direct specialist access without referral.`,
    ],
    a: 'A',
    e: `Positive and social models lead to a preventive healthcare approach, whereas negative and biomedical models lead to a curative approach.`,
  },
];

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export const HIM103_CH1_QUESTIONS: UpsertQuestionInput[] = RAW.map((r, i) => ({
  display_order: i + 1,
  question_type: 'multiple_choice',
  marks: 1,
  question_text: r.q,
  options: r.o.map((text, j) => ({
    option_text: text,
    display_order: j + 1,
    is_correct: LETTERS[j] === r.a,
  })),
  explanation: r.e,
}));
