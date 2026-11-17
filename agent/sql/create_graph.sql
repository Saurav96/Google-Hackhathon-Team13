-- Property graph for the Anchor Closure track.
--
-- Run once in BigQuery Studio (or: bq query --use_legacy_sql=false < agent/sql/create_graph.sql)
-- AFTER the data is loaded and the Enterprise reservation exists (notebook 1b / scripts/load.sh).
--
-- Design decisions (say these in the deck):
--   * Employer blocks ARE nodes. The anchor track starts at an Employer, so it has to be.
--   * Footfall and supply are DIFFERENT labels. They are not equally severe: a supplier can be
--     replaced in a week, a lost lunch crowd does not come back. Keeping them apart lets the
--     traversal go forward along one and backward along the other.
--   * borrowed_from is NOT in the graph. There are no lender node rows to point at, and the loan
--     layer is sparse. The agent reads it as a lookup (fragility evidence), not as a path.
--
-- Naming rules (trap #1 in notebook Section 13): element tables are dataset-qualified and
-- unbackticked; REFERENCES uses the bare table name.

CREATE OR REPLACE PROPERTY GRAPH a4i_econ.LocalEconomy
  NODE TABLES (
    a4i_econ.businesses
      KEY (business_id)
      LABEL Business PROPERTIES (business_id, name, address, naics4, zip, latitude, longitude),
    a4i_econ.employer_blocks
      KEY (block_id)
      LABEL Employer PROPERTIES (block_id, tract, jobs)
  )
  EDGE TABLES (
    a4i_econ.supplies
      KEY (edge_id)
      SOURCE KEY (supplier_id) REFERENCES businesses (business_id)
      DESTINATION KEY (buyer_id) REFERENCES businesses (business_id)
      LABEL Supplies PROPERTIES (intensity, metres),
    a4i_econ.draws_footfall_from
      KEY (edge_id)
      SOURCE KEY (block_id) REFERENCES employer_blocks (block_id)
      DESTINATION KEY (business_id) REFERENCES businesses (business_id)
      LABEL DrawsFootfall PROPERTIES (worker_share, metres)
  );

-- Sanity check (trap #4: duplicate keys silently multiply paths). Both counts must be 0.
-- SELECT COUNT(*) - COUNT(DISTINCT edge_id) AS dup_supplies FROM a4i_econ.supplies;
-- SELECT COUNT(*) - COUNT(DISTINCT edge_id) AS dup_footfall FROM a4i_econ.draws_footfall_from;

-- The signature traversal of this track: forward along DrawsFootfall, then BACKWARD along Supplies.
-- GRAPH a4i_econ.LocalEconomy
-- MATCH p = (e:Employer)-[:DrawsFootfall]->(c:Business)<-[:Supplies]-{1,2}(u:Business)
-- RETURN e.block_id, COUNT(DISTINCT c.business_id) AS hit_directly,
--        COUNT(DISTINCT u.business_id) AS hit_upstream
-- ORDER BY hit_upstream DESC LIMIT 10;
