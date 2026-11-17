"""Unit tests for the judgment layer, on the README's toy block. No BigQuery needed.

    cd agent && python -m pytest tests -q

Toy graph (arrows as in the README):
    Office -DrawsFootfall-> Cafe, Deli, Parking
    Roaster -Supplies-> Cafe, Deli, Kitchen
    Kitchen -Supplies-> Hall
    Bakery  -Supplies-> Roaster          (2 hops upstream of the cafe)
"""

from anchor_agent.tools import exposure as ex


def toy() -> ex.TraversalData:
    return ex.TraversalData(
        direct={"cafe": (400.0, 500.0), "deli": (400.0, 800.0), "parking": (400.0, 400.0)},
        supply_edges={("roaster", "cafe"): 0.04, ("roaster", "deli"): 0.04,
                      ("bakery", "roaster"): 0.02},
        supplier_total_intensity={"roaster": 0.12, "bakery": 0.02},  # roaster also sells to kitchen
        loans={"deli": {"has_loan": True, "charged_off": True}},
    )


def test_footfall_loss_is_anchor_share_times_dependence():
    loss, hops = ex.revenue_loss(toy(), ex.Assumptions(), 2)
    assert abs(loss["cafe"] - 0.5 * 400 / 500) < 1e-9
    assert hops["cafe"] == 0


def test_backward_leg_reaches_suppliers_that_never_touched_the_employer():
    loss, hops = ex.revenue_loss(toy(), ex.Assumptions(), 2)
    assert hops["roaster"] == 1 and hops["bakery"] == 2
    expected_roaster = 0.3 * (0.4 * (0.04 / 0.12) + 0.25 * (0.04 / 0.12))
    assert abs(loss["roaster"] - expected_roaster) < 1e-9
    assert 0 < loss["bakery"] < loss["roaster"]


def test_one_hop_limit_stops_at_roaster():
    loss, _ = ex.revenue_loss(toy(), ex.Assumptions(), 1)
    assert "roaster" in loss and "bakery" not in loss


def test_charge_off_raises_risk():
    a = ex.Assumptions()
    d = toy()
    assert ex.closure_risk("deli", 0.2, d, a) > ex.closure_risk("cafe", 0.2, d, a)


def test_funding_a_buyer_protects_its_suppliers():
    a = ex.Assumptions()
    up = ex.upstream_if_closed(toy(), a, "cafe", 2)
    assert [u["business_id"] for u in up] == ["roaster", "bakery"]
    assert up[1]["chain"] == ["cafe", "roaster", "bakery"]


def test_assume_closed_is_not_funded_and_pushes_full_loss_upstream():
    a = ex.Assumptions()
    base, _ = ex.revenue_loss(toy(), a, 2)
    closed, _ = ex.revenue_loss(toy(), a, 2, ("cafe",))
    assert closed["roaster"] > base["roaster"]
    assert "cafe" not in [r["business_id"] for r in ex.rank(toy(), a, 2, ("cafe",))]


def test_allocation_respects_budget_and_bounds():
    ranked = ex.rank(toy(), ex.Assumptions(), 2)
    grants, reserve = ex.allocate(ranked, 50000, max_grants=5, min_grant=5000, max_grant=15000)
    assert grants
    assert sum(g["amount"] for g in grants) + reserve == 50000
    assert all(5000 <= g["amount"] <= 15000 for g in grants)


def test_sensitivity_reports_every_variant():
    s = ex.sensitivity(toy(), ex.Assumptions(), 2, (), 2)
    assert len(s) == 6 and all("top_pick_unchanged" in r for r in s)
