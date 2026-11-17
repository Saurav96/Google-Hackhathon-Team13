"""Integration tests against the live BigQuery dataset. Run from agent/: pytest -q"""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / "microgrants" / ".env")

from microgrants import analysis, closure, data, tools  # noqa: E402
from microgrants.applicants import APPLICANTS, BUDGET_USD  # noqa: E402

SPEED_QUEEN = "0375063-01-001"
MICROBIZ = "0019117-01-001"
SOUR_FLOUR = "1088753-08-161"
LEAF = "0481879-01-001"
QUEUE = [a["business_id"] for a in APPLICANTS]


def test_every_applicant_exists_in_the_registry():
    assert all(b in data.directory() for b in QUEUE)


def test_traversal_matches_the_data_lane_view_for_the_whole_queue():
    for business_id in QUEUE:
        expected = data.directory()[business_id]
        result = tools.trace_cascade(business_id)
        assert result["exposed_total"] == expected["total_exposed_2hop"]
        assert abs(result["cascade_intensity"] - expected["cascade_intensity"]) < 1e-3


def test_cascade_is_genuinely_multi_hop():
    result = tools.trace_cascade(SPEED_QUEEN)
    assert result["exposed_by_hops"]["2_hop"] > 0
    assert all(len(c["chain"].split(" -> ")) == 3 for c in result["furthest_chains"])


def test_deeper_traversal_never_reaches_fewer_businesses():
    reach = [tools.trace_cascade(SPEED_QUEEN, hops)["exposed_total"] for hops in (1, 2, 3)]
    assert reach == sorted(reach) and reach[0] < reach[1]


def test_hops_are_clamped_and_bad_input_is_tolerated():
    assert tools.trace_cascade(SPEED_QUEEN, 0)["max_hops"] == 1
    assert tools.trace_cascade(SPEED_QUEEN, 99)["max_hops"] == 3
    assert tools.trace_cascade(SPEED_QUEEN, "abc")["max_hops"] == 2


def test_seed_is_never_in_its_own_cascade():
    assert SOUR_FLOUR not in data.exposed_set(SOUR_FLOUR)


def test_leaf_business_has_no_cascade_and_says_so():
    result = tools.trace_cascade(LEAF)
    assert result["exposed_total"] == 0 and result["strongest_chains"] == []
    assert "No cascade" in analysis.grant_impact_scenarios(LEAF, 10_000)["note"]


def test_unknown_ids_return_errors_not_exceptions():
    assert "error" in tools.trace_cascade("nope")
    assert "error" in tools.trace_dependencies("nope")
    assert "error" in analysis.grant_impact_scenarios("nope", 5000)
    assert "error" in analysis.what_if_fails_anyway("nope", SPEED_QUEEN)
    assert "error" in closure.simulate_employer_closure("nope")
    assert "error" in analysis.equity_audit(["nope"])


def test_find_business_handles_empty_partial_and_hostile_input():
    assert tools.find_business("")["count"] == 0
    assert tools.find_business("speed queen")["matches"][0]["business_id"] == SPEED_QUEEN
    assert tools.find_business("'; DROP TABLE businesses; --")["count"] == 0
    assert tools.find_business("zzzz not a business")["count"] == 0


def test_compare_handles_empty_duplicate_and_unknown_ids():
    assert "error" in tools.compare_applicants([])
    rows = tools.compare_applicants([SPEED_QUEEN, SPEED_QUEEN, "nope"])["applicants"]
    assert len(rows) == 2 and "error" in rows[1]


def test_dependencies_read_supplier_first():
    result = tools.trace_dependencies("1278937-05-211")
    assert all(s["chain"].endswith("The Bite") for s in result["direct_suppliers"])


def test_duplicate_registration_is_flagged():
    assert tools.trace_cascade(MICROBIZ)["duplicate_registrations"] == ["Microbiz Security Company"]


def test_plan_stays_in_budget_and_never_double_counts():
    plan = analysis.plan_budget()
    assert plan["budget_usd"] == BUDGET_USD
    assert plan["plan_total_usd"] <= BUDGET_USD and plan["budget_left_usd"] >= 0
    union = set()
    for step in plan["plan"]:
        union |= set(data.exposed_set(step["business_id"]))
        assert step["running_total_protected"] == len(union)
        assert step["newly_protected"] + step["already_protected_by_earlier_grants"] == step["cascade_reach"]
    assert plan["plan_distinct_businesses_protected"] == len(union)


def test_plan_does_not_fund_hubs_unless_asked():
    roles = {s["network_role"].split(" (")[0] for s in analysis.plan_budget()["plan"]}
    assert "Ubiquitous Hub" not in roles
    with_hubs = {s["network_role"].split(" (")[0] for s in analysis.plan_budget(include_hubs=True)["plan"]}
    assert "Ubiquitous Hub" in with_hubs


def test_plan_with_a_budget_too_small_funds_nobody():
    plan = analysis.plan_budget(1000)
    assert plan["plan"] == [] and plan["budget_left_usd"] == 1000 and plan["not_funded"]


def test_scenarios_scale_with_assumptions_and_reject_bad_amounts():
    result = analysis.grant_impact_scenarios(SPEED_QUEEN, 8000, MICROBIZ)
    shielded = [result["scenarios"][k]["expected_businesses_shielded"] for k in ("cautious", "central", "optimistic")]
    assert shielded == sorted(shielded) and "flip_condition" in result
    assert "error" in analysis.grant_impact_scenarios(SPEED_QUEEN, 0)
    assert "error" in analysis.grant_impact_scenarios(SPEED_QUEEN, -5)


def test_what_if_overlap_is_consistent():
    result = analysis.what_if_fails_anyway(SPEED_QUEEN, SOUR_FLOUR)
    assert result["also_exposed_to_the_failure"] + result["still_cleanly_protected"] == result["funded_cascade_reach"]
    assert "error" in analysis.what_if_fails_anyway(SPEED_QUEEN, SPEED_QUEEN)


def test_employer_closure_runs_forward_then_backward():
    block = closure.list_employer_blocks(1)["employer_blocks"][0]["block_id"]
    result = closure.simulate_employer_closure(block)
    assert result["first_order_total"] > 0 and result["second_order_total"] > 0
    first = {s["business_id"] for s in result["first_order_lose_footfall"]}
    view = closure.map_view(block)
    assert all(link["target"] in data.directory() for link in view["links"])
    assert any(link["target"] in first for link in view["links"])
    assert all(0 < s["share_of_footfall_lost"] <= 1 for s in result["first_order_lose_footfall"])


def test_screen_finds_non_applicants_only():
    found = analysis.screen_corridor("Target Anchor")["businesses"]
    assert found and not {b["business_id"] for b in found} & set(QUEUE)
    assert analysis.screen_corridor("no such role")["matches_total"] == 0


def test_equity_audit_reports_the_structural_bias():
    plan = analysis.plan_budget()
    audit = analysis.equity_audit([s["business_id"] for s in plan["plan"]])
    bias = audit["structural_bias_in_the_model"]
    assert bias["food_service_share_of_businesses_with_a_cascade"] > bias["food_service_share_of_all_businesses"]
    assert "error" in analysis.equity_audit([])


def test_tables_behind_the_graph_are_healthy():
    health = analysis.data_health_check()
    assert health["passed"], health["problems"]
    assert health["businesses_without_a_census_tract"] == 0


def test_zero_budget_means_zero_but_the_tool_default_still_works():
    assert analysis.plan_for(0)["budget_usd"] == 0 and analysis.plan_for(0)["plan"] == []
    assert analysis.plan_budget(0)["budget_usd"] == BUDGET_USD


def test_evaluating_a_selection_never_double_counts_and_respects_the_budget():
    result = analysis.evaluate_selection([SPEED_QUEEN, MICROBIZ, SPEED_QUEEN, "nope"], 15_000)
    assert [g["business_id"] for g in result["grants"]] == [SPEED_QUEEN, MICROBIZ]
    union = set(data.exposed_set(SPEED_QUEEN)) | set(data.exposed_set(MICROBIZ))
    assert result["distinct_businesses_in_reach"] == len(union)
    assert result["total_usd"] == 18_000 and result["over_budget"] and result["unallocated_usd"] == -3_000
    empty = analysis.evaluate_selection([], 50_000)
    assert empty["grants"] == [] and empty["audit"] is None and empty["unallocated_usd"] == 50_000


def test_traversal_links_are_typed_and_carry_their_intensity():
    links = data.path_links(data.walk(SPEED_QUEEN, 2, "downstream"))
    assert links and all(l["type"] == "supply" and 0 < l["intensity"] < 1 and l["hop"] in (1, 2) for l in links)
    assert len({l["id"] for l in links}) == len(links)
    assert all(l["source"] == SPEED_QUEEN for l in links if l["hop"] == 1)


def test_worker_demand_shares_sum_to_one():
    blocks = data.worker_demand("0911744-65-001")
    assert blocks and abs(sum(b["share"] for b in blocks) - 1) < 1e-6
    assert data.worker_demand("nope") == ()


def test_closure_counts_distinct_businesses_not_a_sum():
    block = closure.list_employer_blocks(1)["employer_blocks"][0]["block_id"]
    result = closure.simulate_employer_closure(block)
    view = closure.map_view(block)
    assert view["distinct_total"] <= result["first_order_total"] + result["second_order_total"]
    assert view["origin"]["jobs"] == result["employer_block"]["jobs"] and len(view["footfall"]) == result["first_order_total"]


def test_report_edit_proposals_are_validated_and_never_apply_anything():
    from microgrants import report_tools

    ok = report_tools.propose_report_edit("recommendation", "Fund four anchors.", "Clarify")
    assert ok == {"status": "proposed", "section_id": "recommendation", "new_text": "Fund four anchors.", "summary": "Clarify"}
    assert "error" in report_tools.propose_report_edit("no_such_section", "x", "y")
    assert "error" in report_tools.propose_report_edit("recommendation", "  ", "y")
    assert "error" in report_tools.propose_report_edit("recommendation", "x" * 2000, "y")
    assert "error" in report_tools.evaluate_selection(["nope"], 1000)


def test_export_uses_the_snapshot_not_the_default_plan():
    import report

    snapshot = report.Snapshot(revision=4, budget_usd=20_000, selection_ids=[SPEED_QUEEN], narrative="Officer text.")
    text = report.markdown_for(snapshot)
    assert "$20,000" in text and "$8,000" in text and "Officer text." in text and "revision 4" in text
    assert "$33,000" not in text and "$50,000" not in text
    assert report.build_snapshot(snapshot)[:5] == b"%PDF-"
    assert "Draft" in report.markdown_for(report.Snapshot(needs_update=True))
