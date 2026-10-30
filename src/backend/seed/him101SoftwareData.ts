import { CreateExamInput, UpsertQuestionInput } from '../types/domain.ts';

export const HIM101_SW_METADATA: CreateExamInput = {
  title: 'HIM 101: Software System',
  description:
    'Comprehensive examination on Computer Software & System Software covering operating system functions, 5-stage booting, process and memory management, virtual memory and thrashing, spooling, device drivers, server OS, virtualization, and utility programs.',
  instructions:
    'This examination consists of 40 questions allocated for 60 minutes (1 hour) with a total of 50 marks. Section A contains 35 Multiple Choice Questions (Questions 1–35, 1 mark each = 35 marks). Section B contains 5 Short Answer Questions (Questions 36–40, 3 marks each = 15 marks). You may navigate between questions using the Question Navigator pane. When you submit your exam, your Section A objective score (out of 35) is calculated immediately. Your Section B short answer responses are submitted to the instructor for evaluation (out of 15 marks). Your final score (out of 50) will be released following instructor review.',
  duration_minutes: 60,
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

interface RawMcq {
  q: string;
  o: string[];
  a: 'A' | 'B' | 'C' | 'D';
  e: string;
}

const SECTION_A_MCQS: RawMcq[] = [
  {
    q: 'Which of the following best defines computer software?',
    o: [
      'The physical, electronic, and mechanical components that comprise a computer system',
      'A series of related instructions organized for a common purpose that tells the computer what tasks to perform and how',
      'The permanent semiconductor chips embedded on the motherboard storing system firmware',
      'The peripheral input and output devices used to interface with human operators',
    ],
    a: 'B',
    e: 'Software consists of a series of related instructions, organized for a common purpose, that directs hardware on what operations to perform and how to carry them out.',
  },
  {
    q: 'How does system software fundamentally differ from application software?',
    o: [
      'System software is exclusively written in interpreted languages, whereas application software is compiled.',
      'System software serves as the interface between the user, application software, and computer hardware, whereas application software performs user-specific productivity tasks.',
      'System software can only run when connected to the Internet, whereas application software runs completely offline.',
      'System software requires user interaction for every instruction, whereas application software operates autonomously in background firmware.',
    ],
    a: 'B',
    e: 'System software controls and maintains the operations of the computer and its devices, serving as the bridge between application software, human users, and system hardware.',
  },
  {
    q: 'Which category of software is permanently or semi-permanently etched into non-volatile read-only memory (ROM) chips on hardware devices?',
    o: ['Middleware', 'Firmware', 'Freeware', 'Shareware'],
    a: 'B',
    e: 'Firmware consists of ROM-based software instructions etched onto hardware chips (such as the system BIOS) that control basic device operation without needing disk storage.',
  },
  {
    q: 'What is the primary function of middleware in enterprise software environments?',
    o: [
      'To provide diagnostic hardware cooling controls inside system chassis',
      'To enable communication, data exchange, and management between disparate software applications and operating systems',
      'To compile source code into machine instructions during system booting',
      'To defragment fragmented disk blocks on optical storage media',
    ],
    a: 'B',
    e: 'Middleware is software that acts as a bridge or connector between different applications, databases, or network architectures to allow seamless data exchange.',
  },
  {
    q: 'What is the core component of an operating system that remains resident in RAM while the computer is running?',
    o: ['The Shell', 'The Kernel', 'The Spooler', 'The Hypervisor'],
    a: 'B',
    e: 'The kernel is the core of an operating system. It manages memory, processes, and devices, maintaining resident status in RAM from boot time until the computer is powered down.',
  },
  {
    q: 'What distinguishes a "cold boot" from a "warm boot"?',
    o: [
      'A cold boot restarts the computer using an operating system menu command, whereas a warm boot requires cycling electrical power switches.',
      'A cold boot powers on a computer that has been turned completely off, whereas a warm boot uses operating system instructions to restart without turning power off.',
      'A cold boot clears cache memory only, whereas a warm boot overwrites firmware instructions in CMOS.',
      'A cold boot is used solely for server operating systems, whereas a warm boot is restricted to embedded systems.',
    ],
    a: 'B',
    e: 'A cold boot (cold start) powers up a computer from a completely unpowered state, whereas a warm boot restarts the system while electrical power remains active.',
  },
  {
    q: 'During the 5-step boot process, what is the immediate purpose of the Power-On Self-Test (POST)?',
    o: [
      'To compress user documents on the primary solid-state drive',
      'To perform diagnostic tests that check system components like RAM, keyboard, buses, and drives for proper electrical function',
      'To establish an encrypted VPN connection to the institutional domain controller',
      'To defragment fragmented clusters in virtual memory before loading the GUI',
    ],
    a: 'B',
    e: 'The Power-On Self-Test (POST) runs during step 2 of booting. The BIOS tests system hardware components (such as memory modules, keyboard, and storage controllers) for functional integrity.',
  },
  {
    q: 'What role does the CMOS chip play during the system boot sequence?',
    o: [
      'It stores the entire operating system graphical user interface permanently.',
      'It contains the configuration parameters (such as drive configurations, system clock, and boot order) that POST compares against detected hardware.',
      'It acts as the primary paging swap file for virtual memory.',
      'It translates high-level printer commands into dot-matrix raster patterns.',
    ],
    a: 'B',
    e: 'CMOS memory stores configuration data such as drive parameters, current time/date, and hardware inventory, which the BIOS compares against hardware detected during POST.',
  },
  {
    q: 'How does Sleep mode differ from Hibernate mode on a modern workstation?',
    o: [
      'Sleep mode writes open state to the hard disk and cuts all power, whereas Hibernate mode keeps RAM powered.',
      'Sleep mode maintains open documents and programs in physical RAM using low power, whereas Hibernate mode writes all memory contents to the disk/SSD and cuts power completely.',
      'Sleep mode takes several minutes to resume, whereas Hibernate mode resumes in milliseconds.',
      'Sleep mode deletes unsaved data, whereas Hibernate mode automatically sends unsaved files to cloud storage.',
    ],
    a: 'B',
    e: 'Sleep mode saves the active desktop state to RAM and enters a low-power state for near-instant wake-up. Hibernate saves RAM state to a disk file (hiberfil.sys) and powers off completely.',
  },
  {
    q: 'Which operating system user interface requires users to type exact keywords, parameters, and syntax to issue instructions to the computer?',
    o: [
      'Graphical User Interface (GUI)',
      'Command-Line Interface (CLI)',
      'Natural User Interface (NUI)',
      'Touch Gesture Interface (TGI)',
    ],
    a: 'B',
    e: 'A Command-Line Interface (CLI) requires users to type precise text commands, switches, and parameters at a prompt to direct operating system operations.',
  },
  {
    q: 'A user interacts with software by speaking voice commands, touching multi-touch displays, or making physical gestures in front of depth cameras. Which interface model does this describe?',
    o: [
      'Command-Line Interface (CLI)',
      'Batch Processing Interface (BPI)',
      'Natural User Interface (NUI)',
      'Menu-Driven Character Interface (MDCI)',
    ],
    a: 'C',
    e: 'Natural User Interfaces (NUIs) enable interaction through natural human behaviors including speech, touch gestures, facial recognition, and body motion.',
  },
  {
    q: 'What capability allows an operating system to execute two or more programs or active tasks concurrently for a single user?',
    o: ['Single-tasking', 'Multitasking', 'Virtual Spooling', 'Single-threading'],
    a: 'B',
    e: 'Multitasking allows a computer to run multiple programs concurrently, with the CPU switching between task execution slices so rapidly that they appear simultaneous.',
  },
  {
    q: 'In preemptive multitasking, how does the operating system maintain control over processor utilization?',
    o: [
      'It waits until each application voluntarily relinquishes the CPU before giving time to the next program.',
      'It allocates specific CPU time slices and interrupts executing programs to switch control to another waiting process.',
      'It disables virtual memory whenever more than two background tasks are active.',
      'It converts multi-threaded programs into sequential batch cards.',
    ],
    a: 'B',
    e: 'Preemptive multitasking gives the OS authoritative control to interrupt (preempt) running programs and allocate CPU time slices according to priority.',
  },
  {
    q: 'What is multiprocessing in modern computing architectures?',
    o: [
      'Running two copies of an antivirus program on a single core simultaneously',
      'The simultaneous use of two or more central processing units or execution cores within a single computer system to execute instructions',
      'Storing multiple copies of a document across separate physical hard disk sectors',
      'Allowing multiple remote students to log in using a single shared password',
    ],
    a: 'B',
    e: 'Multiprocessing refers to an operating system utilizing two or more physical CPUs or multi-core processors simultaneously to divide and process workloads.',
  },
  {
    q: 'What is virtual memory?',
    o: [
      'A software simulation of a 3D gaming headset using cloud rendering',
      'A memory management capability where the operating system allocates a portion of secondary storage to function as additional physical RAM',
      'A temporary RAM drive created solely for storing firmware updates',
      'A permanent read-only sector on optical disks used for system recovery',
    ],
    a: 'B',
    e: 'Virtual memory allows an OS to overcome physical RAM constraints by allocating secondary storage (such as a hard disk or SSD) as an extension of main memory.',
  },
  {
    q: 'What is the fixed-size block of data transferred between physical RAM and secondary storage during virtual memory operations called?',
    o: ['A sector', 'A cluster', 'A page', 'A cylinder'],
    a: 'C',
    e: 'In virtual memory systems, data and instructions are divided into fixed-size blocks called "pages", which are swapped between RAM and secondary storage.',
  },
  {
    q: 'What condition occurs when an operating system spends more time swapping pages between RAM and disk than executing instructions, resulting in severe performance degradation?',
    o: ['Deadlock', 'Thrashing', 'Spooling', 'Buffering'],
    a: 'B',
    e: 'Thrashing occurs when physical RAM is exhausted and the operating system is forced into continuous, heavy page-swapping between RAM and disk storage, slowing execution to a halt.',
  },
  {
    q: 'What is the designated secondary storage file where pages of inactive data from physical memory are temporarily stored in virtual memory called?',
    o: ['Registry file', 'Swap file (pagefile)', 'Index file', 'Spool catalog'],
    a: 'B',
    e: 'A swap file (or paging file, such as pagefile.sys) is the dedicated file on secondary storage used by the OS to hold memory pages swapped out of RAM.',
  },
  {
    q: 'What is print spooling?',
    o: [
      'The physical process of winding ink ribbons inside impact printers',
      'The process of intercepting print jobs, writing them to a disk buffer or queue, and feeding them to the printer at device speed so the CPU remains free for applications',
      'Compressing graphics files into vector format before sending them over Bluetooth',
      'Scanning documents for optical character recognition before archiving',
    ],
    a: 'B',
    e: 'Print spooling sends print jobs to a buffer or temporary storage on disk (the spool) where they wait in queue, releasing the application and CPU immediately without waiting for physical print speeds.',
  },
  {
    q: 'What is a device driver?',
    o: [
      'A mechanical arm that aligns laser heads inside magnetic storage drives',
      'A specialized program that tells the operating system how to communicate with and control a specific hardware device',
      'A utility program designed solely to clean dust and debris from cooling fans',
      'A hardware expansion card that provides additional USB ports',
    ],
    a: 'B',
    e: 'A device driver is a specialized software program that converts generalized operating system I/O instructions into the proprietary hardware signals required by a specific peripheral device.',
  },
  {
    q: 'What is the feature of modern operating systems that automatically configures new hardware devices as soon as they are connected to the computer?',
    o: ['Plug and Play (PnP)', 'Dynamic Link Library (DLL)', 'Spool and Run', 'Auto-Defrag'],
    a: 'A',
    e: 'Plug and Play (PnP) enables the operating system to automatically detect, assign resources to, and load drivers for newly connected hardware peripherals without manual jumper configuration.',
  },
  {
    q: 'Which operating system tool tracks and displays real-time statistics regarding processor utilization, memory allocation, network throughput, and disk read/write activity?',
    o: ['Disk Defragmenter', 'Performance Monitor (Resource Monitor)', 'File Compression Utility', 'Uninstaller'],
    a: 'B',
    e: 'A Performance Monitor or Resource Monitor utility assesses and reports real-time system resource consumption, including CPU, memory, disk activity, and network bandwidth.',
  },
  {
    q: 'Which Microsoft operating system family is specifically engineered to manage client-server enterprise networks, Active Directory domains, and virtualization workloads?',
    o: ['Windows 10 Home', 'Windows Server', 'Windows CE', 'MS-DOS'],
    a: 'B',
    e: 'Windows Server (such as Windows Server 2008, 2016, 2019, 2022) is engineered for enterprise networks, managing shared resources, domain security, network services, and virtualization.',
  },
  {
    q: 'What is virtualization in server computing?',
    o: [
      'Replacing physical computer monitors with virtual reality headsets',
      'The practice of sharing or partitioning computing resources to run multiple operating system environments simultaneously on a single physical host machine',
      'Backing up database tables to optical CD-ROM discs',
      'Translating high-level programming languages into assembly language',
    ],
    a: 'B',
    e: 'Virtualization abstracts physical hardware so that multiple isolated virtual environments (virtual machines) can run their own operating systems on one physical server.',
  },
  {
    q: 'In virtualization terminology, what is the role of the "host operating system"?',
    o: [
      'The guest operating system running inside a virtual sandbox',
      'The primary operating system that runs directly on the physical computer hardware and hosts the virtualization software or hypervisor',
      'An application software package used exclusively for viewing PDF documents',
      'A temporary boot firmware chip located on the graphics card',
    ],
    a: 'B',
    e: 'The host operating system is installed directly on the physical hardware and coordinates physical resources, supporting the virtualization layer that hosts guest operating systems.',
  },
  {
    q: 'What is the operating system running inside an isolated virtual machine called?',
    o: ['Host OS', 'Guest OS', 'Firmware OS', 'Master OS'],
    a: 'B',
    e: 'The operating system installed inside a virtual machine environment is referred to as the guest operating system.',
  },
  {
    q: 'Which edition of Windows 10 is designed specifically for academic institutions, incorporating enterprise-grade security and classroom management tools?',
    o: ['Windows 10 Home', 'Windows 10 Mobile', 'Windows 10 Education', 'Windows 10 Starter'],
    a: 'C',
    e: 'Windows 10 Education is customized for academic settings, providing staff and students with advanced security, management, and administrative tools derived from Windows 10 Enterprise.',
  },
  {
    q: 'The Mac operating system (macOS / OS X) is fundamentally built upon which established operating system foundation?',
    o: ['MS-DOS', 'UNIX', 'OS/2 Warp', 'VMS'],
    a: 'B',
    e: 'macOS (originally Mac OS X) is built upon a UNIX-based kernel (Darwin), delivering high stability, POSIX compliance, and robust multi-user security.',
  },
  {
    q: 'Which operating system was created by Linus Torvalds in 1991 as an open-source, UNIX-compatible operating system kernel available under free software licenses?',
    o: ['Windows NT', 'Solaris', 'Linux', 'iOS'],
    a: 'C',
    e: 'Linux was developed by Linus Torvalds in 1991. It is an open-source, UNIX-compatible kernel whose source code can be modified and distributed by anyone worldwide.',
  },
  {
    q: 'Where are embedded operating systems typically found?',
    o: [
      'Exclusively in multi-chassis corporate data centers',
      'In specialized devices such as digital cameras, automotive dashboard systems, smart TVs, and medical telemetry devices',
      'Only on high-end mainframe supercomputers',
      'In legacy punch-card reading machines',
    ],
    a: 'B',
    e: 'Embedded operating systems reside on ROM chips inside dedicated electronic devices, smartphones, consumer appliances, smart cars, and medical telemetry units.',
  },
  {
    q: 'What is the function of a disk defragmenter utility program?',
    o: [
      'To erase all temporary browser cookies and caches from the computer',
      'To reorganize contiguous files and unused space on a magnetic hard disk so that files are stored in contiguous sectors, speeding up file access',
      'To create duplicate copies of the operating system kernel across multiple partitions',
      'To convert lossy JPEG images into lossless PNG formats',
    ],
    a: 'B',
    e: 'A disk defragmenter reorganizes fragmented files on magnetic storage so that related file sectors are physically contiguous, minimizing drive head movements and accelerating read/write speeds.',
  },
  {
    q: 'What is the primary role of a personal firewall utility?',
    o: [
      'To extinguish physical electrical fires inside the computer power supply unit',
      'To detect and protect a personal computer and its data from unauthorized network intrusions and suspect incoming/outgoing network packets',
      'To compress email attachments before transmission',
      'To remove physical scratches from optical compact discs',
    ],
    a: 'B',
    e: 'A personal firewall inspects inbound and outbound network communications, blocking unauthorized traffic and protecting the computer from network-based exploits and unauthorized access.',
  },
  {
    q: 'How does a computer worm differ from a computer virus?',
    o: [
      'A virus requires human execution of an infected host file to spread, whereas a worm copies itself automatically across networks without user intervention.',
      'A worm only infects mobile phones, whereas a virus only infects mainframe computers.',
      'A virus is open-source software, whereas a worm is proprietary commercial software.',
      'A worm harmlessly cleans cache files, whereas a virus permanently deletes BIOS firmware.',
    ],
    a: 'A',
    e: 'A computer virus requires an existing host file and human action to propagate, whereas a computer worm is independent malware that actively replicates itself across computer networks without user intervention.',
  },
  {
    q: 'What type of malicious program masquerades as a legitimate, desirable application (such as a game or utility) while hiding destructive code?',
    o: ['Trojan horse', 'Firewall filter', 'Disk defragmenter', 'Print spooler'],
    a: 'A',
    e: 'A Trojan horse disguises itself as a legitimate application to deceive the user into installing it. Unlike viruses and worms, a Trojan horse does not replicate itself.',
  },
  {
    q: 'Which file compression category allows exact bit-for-bit reconstruction of the original file when decompressed, making it mandatory for medical records, spreadsheets, and program executables?',
    o: ['Lossy compression', 'Lossless compression', 'Destructive sampling', 'Vector rendering'],
    a: 'B',
    e: 'Lossless compression preserves 100% of original data bits upon decompression (e.g., ZIP format). Lossy compression (e.g., JPEG, MP3) permanently discards redundant data to achieve higher compression ratios.',
  },
];

const SECTION_B_SHORT_ANSWERS: UpsertQuestionInput[] = [
  {
    display_order: 36,
    question_type: 'short_answer',
    marks: 3,
    negative_marks: 0,
    is_required: true,
    question_text:
      'Distinguish between a cold boot and a warm boot, and explain the specific function of the Power-On Self-Test (POST) during the boot process.',
    explanation:
      'Model Answer & 3-Mark Rubric:\n' +
      '• Point 1 (1 Mark): Cold Boot — powering on a computer that has been turned completely off (cold start).\n' +
      '• Point 2 (1 Mark): Warm Boot — using operating system commands or key combinations (e.g. Ctrl+Alt+Del) to restart the computer without turning electrical power off (warm start).\n' +
      '• Point 3 (1 Mark): Power-On Self-Test (POST) — a diagnostic routine executed by system BIOS/firmware during boot step 2 that checks hardware components (RAM, motherboard, keyboard, storage drives) for proper electrical and functional operation.',
    accepted_answers: [],
    rubric_keywords: [],
  },
  {
    display_order: 37,
    question_type: 'short_answer',
    marks: 3,
    negative_marks: 0,
    is_required: true,
    question_text:
      'Explain how virtual memory works in modern operating systems. In your response, define the roles of the swap file, paging, and the consequence of thrashing.',
    explanation:
      'Model Answer & 3-Mark Rubric:\n' +
      '• Point 1 (1 Mark): Virtual Memory Concept — a memory management technique where the OS allocates secondary storage (hard disk or SSD) to act as an extension of physical RAM when main memory is full.\n' +
      '• Point 2 (1 Mark): Paging & Swap File — memory is divided into fixed-size blocks called pages; inactive pages are swapped between RAM and a dedicated swap file (paging file, e.g. pagefile.sys) on disk.\n' +
      '• Point 3 (1 Mark): Thrashing — occurs when the operating system spends more time continuously swapping pages between RAM and disk than executing user instructions, causing the computer to become sluggish or completely unresponsive.',
    accepted_answers: [],
    rubric_keywords: [],
  },
  {
    display_order: 38,
    question_type: 'short_answer',
    marks: 3,
    negative_marks: 0,
    is_required: true,
    question_text:
      'Differentiate between a host operating system and a guest operating system in the context of system virtualization.',
    explanation:
      'Model Answer & 3-Mark Rubric:\n' +
      '• Point 1 (1.5 Marks): Host Operating System — the primary operating system installed directly on the physical hardware or hypervisor host that manages the physical processors, memory, storage, and network interfaces, and provides the virtualization platform.\n' +
      '• Point 2 (1.5 Marks): Guest Operating System — the secondary operating system installed and executing inside an isolated virtual machine (VM) environment on top of the host, unaware that its hardware is virtualized.',
    accepted_answers: [],
    rubric_keywords: [],
  },
  {
    display_order: 39,
    question_type: 'short_answer',
    marks: 3,
    negative_marks: 0,
    is_required: true,
    question_text:
      'Compare Sleep mode and Hibernate mode in terms of where active system state is preserved and total electrical power consumption.',
    explanation:
      'Model Answer & 3-Mark Rubric:\n' +
      '• Point 1 (1.5 Marks): Sleep Mode — saves active open documents, programs, and desktop state in physical RAM; maintains a tiny trickle of electrical power to RAM chips; allows near-instantaneous resume (seconds).\n' +
      '• Point 2 (1.5 Marks): Hibernate Mode — copies all contents of RAM to a dedicated file on non-volatile secondary storage (hard drive/SSD, e.g. hiberfil.sys) and powers off the computer completely (zero electrical power draw); takes slightly longer to restart as disk state is read back into RAM.',
    accepted_answers: [],
    rubric_keywords: [],
  },
  {
    display_order: 40,
    question_type: 'short_answer',
    marks: 3,
    negative_marks: 0,
    is_required: true,
    question_text:
      'Contrast computer viruses, computer worms, and Trojan horses with respect to how they replicate and conceal themselves.',
    explanation:
      'Model Answer & 3-Mark Rubric:\n' +
      '• Point 1 (1 Mark): Computer Virus — malicious code that attaches itself to a host program or file; requires human action (such as executing an infected file) to replicate and spread.\n' +
      '• Point 2 (1 Mark): Computer Worm — standalone malicious program that replicates itself automatically across computer networks without requiring human interaction or an existing host file.\n' +
      '• Point 3 (1 Mark): Trojan Horse — malicious software that conceals itself by masquerading as a legitimate, desirable application (game, utility); unlike viruses and worms, it does NOT replicate itself.',
    accepted_answers: [],
    rubric_keywords: [],
  },
];

export const HIM101_SW_QUESTIONS: UpsertQuestionInput[] = [
  ...SECTION_A_MCQS.map((raw, idx) => ({
    display_order: idx + 1,
    question_type: 'multiple_choice' as const,
    marks: 1,
    negative_marks: 0,
    is_required: true,
    question_text: raw.q,
    explanation: raw.e,
    options: raw.o.map((optText, optIdx) => ({
      option_text: optText,
      display_order: optIdx + 1,
      is_correct: ['A', 'B', 'C', 'D'][optIdx] === raw.a,
    })),
  })),
  ...SECTION_B_SHORT_ANSWERS,
];
