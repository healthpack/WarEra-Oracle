# WarEra-Oracle
Multi-Account Detection Heuristics

Summary of WarEra Oracle
WarEra Oracle is a web-based, automated diagnostic application designed to identify potential multi-account networks and bot farms within the browser game WarEra. It functions by querying public API endpoints—dynamically load-balancing between the official WarEra API and the community-hosted WarEraStats Gateway—to extract player profiles, company rosters, and market transaction ledgers.

The application utilizes concurrent request pooling and token-bucket rate limiting to process entire in-game countries or specific users. It cross-references the extracted data against a set of predefined behavioral and economic heuristics, outputting the findings in a hierarchical dashboard. The tool provides statistical indicators of coordinated account activity rather than definitive proof of rule-breaking.
Analysis and Scanning Rules
The engine executes scans and evaluates suspects based on the following strict logical parameters:

1. Target Acquisition & Network Rules
   
   API Load Balancing: The tool distributes requests between the WarEraStats Gateway (capped at 3500 requests/minute) and the Official API (capped at 400 requests/minute). It prioritizes the Gateway for speed and falls back to the Official API if an endpoint is unsupported or errors out.
   
   Concurrency: Processes up to 50 users simultaneously, utilizing a 10ms micro-stagger to prevent triggering DDoS protection.
   
   Boss Prerequisite: Any scanned user found to own 1 companies is instantly cleared and excluded from analysis, but their transactions are still checked.
   
   Worker Deduplication: Workers are strictly deduplicated by their internal Database ID to prevent "ghost" clones if a company payload is returned multiple times.
   
3. Worker Filtering
      
   Inactivity Exemption: If a worker is marked as inactive (isActive: false) and their wage is above the defined suspicious threshold, they are completely excluded from the heuristic analysis.

4. Heuristic Triggers
   
   Low Wage
   
   Triggers if workers are paid less than or equal to the user-defined threshold (default: 0.110).
   
   Requires a minimum of 2 workers meeting this condition to flag the employer.


5. Naming Pattern
   
   Strips the default user_ prefix from all names.
   
   Triggers if 2 or more workers share an identical, contiguous string of at least 3 characters in their usernames (ignoring case and whitespace).
   
   Cloned Progression
   
   Skill Fingerprinting: Ignores all combat stats, metadata (e.g., current energy bars), and company limits. It extracts only economic skills (Energy, Production, Management, Entrepreneurship).
   
   Baseline Filter: Only counts economic points actively invested above the game's default starting values. If a worker has only default economic stats, they are classified as DEFAULT_ECO and ignored.
   
   Clustering: Triggers if 2 or more workers share the exact same economic skill signature AND fall within the same 10-level band (e.g., Level 10-19).


6. Money Laundering
   
   MU Linkage: Verifies if the Boss and the Worker belong to the exact same Military Unit.
   
   Level Cap: Explicitly ignores any worker Level 22 or higher.
   
   Transaction Audit: Scans the last 30 days of donation ledgers.
   
   Threshold: Triggers if a worker donates more than 25 coins in a single transaction, OR if their total donations exceed 60 coins within a rolling 7-day window.


7. Transaction Abuse (Wash Trading)
   
   Item Fingerprinting: Because item IDs change upon trading, the engine creates a persistent fingerprint using the item's code, lastAcquisitionAt timestamp, and exact skills (combat stats).
   
   Classic Wash: Triggers if the Boss trades an item directly back-and-forth with the same user (A ➔ B and B ➔ A). Minimum threshold: 1.0 coins.
   
   Bounced Wash: Triggers if the Boss sells an item and eventually buys it back from a different user (A ➔ B ➔ C ➔ A). Both B and C are flagged. Minimum threshold: 25.0 coins.
   
   Merchant Protection: Standard buying and reselling (B ➔ A ➔ C) is recognized as legitimate flipping and ignored.
   
   Weighting & Mapping: If the partner is a worker, the detection counts as 2x severity. All interconnected wash-traders are grouped into a single ring and visualized hierarchically.


8. No Production Bonus (Shell Companies)
   
   Level Cap: Ignores workers who are Level 30 or higher, or inactive.
   
   Cross-Referencing: Identifies companies personally owned by the worker. It cross-references the company's produced item against the regional and country-level specialization bonuses (ignoring temporary "timed deposits").
   
   Threshold: Triggers if >25% of a worker's personal company portfolio consists of companies receiving zero production bonuses.
   
   Isolation Rule: If this is the only anomaly detected on an employer's network, the threshold becomes extremely strict: it requires at least 2 workers who each have >= 50% zero-bonus companies to trigger a flag.
