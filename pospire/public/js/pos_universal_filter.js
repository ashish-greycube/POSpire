frappe.provide("frappe.pospire_filter");

(function () {
	const DASHBOARD_NAME = "POSpire Dashboard";
	const WORKSPACE_NAME = "POSpire";

	frappe.pospire_filter._selected = { company: null, pos_profile: null };

	// Server-resolved starting company (pospire.boot._default_dashboard_company)
	// takes priority over the site's default company, which may have no POS
	// Profile at all and would otherwise leave the dashboard blank.
	frappe.pospire_filter.get_company = function () {
		return (
			frappe.pospire_filter._selected.company ||
			frappe.boot.pospire_dashboard_company ||
			null
		);
	};

	// Doctypes that actually carry pos_profile. An explicit list, not
	// frappe.meta.has_field(): meta may not be loaded on the dashboard page
	// and a "no" there would silently drop the till filter. POS Offer is
	// left out on purpose (offers are company-wide, so filtering them by
	// till is what made "Active Promotions" read 0), and so is the Customer
	// card, whose doctype has no till at all.
	const TILL_DOCTYPES = ["Sales Invoice", "POS Opening Shift"];

	// Single selected till, for filters that take one value (the Report
	// chart's own pos_profile filter). Blank means "no till selected", which
	// that report already treats as all tills.
	frappe.pospire_filter.get_pos_profile = function () {
		return frappe.pospire_filter._selected.pos_profile || "";
	};

	function till_doctype(doc) {
		const doctype = doc.parent_document_type || doc.document_type;
		return TILL_DOCTYPES.includes(doctype) ? doctype : null;
	}

	// Rebuilt on every Apply, never patched in place: dashboard_chart.get()
	// and number_card.get_result() use the filters they are sent, and only
	// fall back to filters_json (which has no evaluated company) when none
	// arrive. Leaving the previous Apply's list in place would keep
	// filtering by a till the user has just cleared.
	//
	// When no till is selected the row is simply not added, rather than sent
	// as a blank value: blank means "till is empty", which is not the same
	// as "any till".
	function build_filters(doc) {
		const filters = frappe.dashboard_utils.get_all_filters(doc) || [];
		const till = frappe.pospire_filter._selected.pos_profile;
		const doctype = till && till_doctype(doc);

		// Child-table charts (Sales Invoice Item/Payment) have no pos_profile
		// of their own, so the row goes on the parent, the same way their
		// company filter does.
		return doctype ? [...filters, [doctype, "pos_profile", "=", till]] : filters;
	}

	function refresh_chart(widget, awaitable) {
		// Report charts take a filter dict, not a list, and carry their own
		// pos_profile expression, so they only need their stale copy dropped
		// before the re-render re-evaluates it.
		if (widget.chart_doc.chart_type === "Report") {
			delete widget.filters;
		} else {
			widget.filters = build_filters(widget.chart_doc);
		}

		// The user's saved chart config is deliberately left alone: clearing
		// it would throw away filters they set themselves, for good, every
		// time someone pressed Apply. Only the in-memory copy goes, so the
		// bar's filters win for this render.
		if (widget.chart_settings && widget.chart_settings.filters) {
			delete widget.chart_settings.filters;
		}
		delete widget.filter_group;

		// refresh() re-renders and fetches (make_chart -> fetch_and_update_chart).
		if (!awaitable) {
			widget.refresh();
			return null;
		}

		const done = new Promise((resolve) => {
			widget._pospire_resolve_refresh = resolve;
		});
		widget.refresh();
		return done;
	}

	function refresh_number_card(widget) {
		// get_settings() calls this on every refresh, so the override keeps
		// working for later refreshes and always reads the current selection.
		widget.get_filters = () => build_filters(widget.card_doc);
		widget.refresh();
	}

	async function apply_filters(
		selected,
		{ chart_widgets = [], number_card_widgets = [], awaitable_charts = false } = {}
	) {
		frappe.pospire_filter._selected.company = selected.company;
		frappe.pospire_filter._selected.pos_profile = selected.pos_profile || null;

		const pending = chart_widgets
			.filter((widget) => widget && widget.chart_doc)
			.map((widget) => refresh_chart(widget, awaitable_charts))
			.filter(Boolean);

		number_card_widgets
			.filter((widget) => widget && widget.card_doc)
			.forEach(refresh_number_card);

		await Promise.all(pending);

		// Remembered so a reload (or coming back to this page later) starts
		// on the same company instead of falling back to the site default —
		// a per-user key, not Session Defaults, so this never touches the
		// default company used on new Sales Invoices/Orders.
		frappe.call("pospire.pospire.api.dashboard_filter.set_dashboard_company", {
			company: selected.company,
		});
	}

	function make_link_control(df, $parent) {
		const f = frappe.ui.form.make_control({ df, parent: $parent });
		f.refresh();
		if (!f.$input) f.make_input();

		f.$wrapper.find(".form-group").css("margin-bottom", 0);
		return f;
	}

	function build_dashboard_bar(on_apply) {
		const $bar = $(`
			<div class="pospire-universal-filter-bar" style="display:flex;align-items:flex-end;
				gap:12px;padding:var(--margin-md) 12px;flex-wrap:wrap;">
				<div class="pospire-filter-company" style="width:220px;"></div>
				<div class="pospire-filter-pos-profile" style="width:220px;"></div>
				<button class="btn btn-primary btn-sm pospire-filter-apply" style="height:30px;">${__(
					"Apply Filter"
				)}</button>
			</div>
		`);

		const company_field = make_link_control(
			{
				fieldname: "pospire_filter_company",
				label: __("Company"),
				fieldtype: "Link",
				options: "Company",
				// Only companies that have a POS Profile, the same list the
				// server picks the starting company from. Offering the rest
				// just lets the user land on a blank dashboard, and that
				// choice would then be remembered for next time.
				get_query: () => ({
					filters: {
						name: ["in", frappe.boot.pospire_eligible_dashboard_companies || []],
					},
				}),
			},
			$bar.find(".pospire-filter-company")
		);
		const pos_profile_field = make_link_control(
			{
				fieldname: "pospire_filter_pos_profile",
				label: __("POS Profile"),
				fieldtype: "Link",
				options: "POS Profile",
				get_query: () => ({ filters: { company: company_field.get_value() } }),
			},
			$bar.find(".pospire-filter-pos-profile")
		);

		let last_company_value = null;
		function clear_pos_profile_if_company_changed() {
			const current = company_field.get_value();
			if (current !== last_company_value) {
				last_company_value = current;
				pos_profile_field.set_value("");
			}
		}
		company_field.$input.on(
			"awesomplete-select change blur",
			clear_pos_profile_if_company_changed
		);

		const $apply_btn = $bar.find(".pospire-filter-apply");
		$apply_btn.on("click", async () => {
			const company = company_field.get_value();
			if (!company) {
				frappe.show_alert({ message: __("Select a Company first"), indicator: "orange" });
				return;
			}

			const original_label = $apply_btn.text();
			$apply_btn.prop("disabled", true).text(__("Applying..."));
			try {
				await on_apply(company, pos_profile_field.get_value());
			} finally {
				$apply_btn.prop("disabled", false).text(original_label);
			}
		});

		return { $bar, company_field, pos_profile_field };
	}

	function detach_from_dashboard() {
		if (frappe.dashboard && frappe.dashboard._pospire_filter_bar) {
			frappe.dashboard._pospire_filter_bar.$bar.hide();
		}
	}

	function attach_to_dashboard() {
		const dashboard = frappe.dashboard;
		if (!dashboard._pospire_filter_bar) {
			const bar = build_dashboard_bar((company, pos_profile) => {
				const chart_widgets =
					(dashboard.chart_group && dashboard.chart_group.widgets_list) || [];
				const number_card_widgets =
					(dashboard.number_card_group && dashboard.number_card_group.widgets_list) ||
					[];
				// No global patching needed here: the Dashboard page's own
				// WidgetGroup already keeps a live widgets_list (same one
				// its own "Refresh All" menu item uses), and none of its
				// charts are the slow Report-type kind, so a plain
				// fire-and-forget refresh() is enough.
				return apply_filters(
					{ company, pos_profile },
					{ chart_widgets, number_card_widgets, awaitable_charts: false }
				);
			});

			dashboard.container.parent().prepend(bar.$bar);
			dashboard._pospire_filter_bar = bar;
		}

		const bar = dashboard._pospire_filter_bar;
		bar.$bar.show();
		if (!bar.company_field.get_value()) {
			bar.company_field.set_value(frappe.pospire_filter.get_company());
		}
	}

	// The Workspace has no ready-made widgets_list — unlike the Dashboard
	// page's WidgetGroup, its blocks don't keep a live registry anywhere. A
	// capture via frappe.widget.make_widget is the only way to reach the
	// rendered widget instances, so it's installed only while this specific
	// workspace is open and torn down the moment the user navigates away —
	// never left patched globally for the rest of the desk session.
	let workspace_capture = null; // { original_make_widget, charts: [], number_cards: [] } | null
	let chart_render_patch = null; // { proto, original_render } | null

	function ensure_chart_render_is_awaitable(widget) {
		if (chart_render_patch) return;
		const proto = Object.getPrototypeOf(widget);
		const original_render = proto.render;
		proto.render = function (...args) {
			const result = original_render.apply(this, args);
			if (this._pospire_resolve_refresh) {
				const resolve = this._pospire_resolve_refresh;
				this._pospire_resolve_refresh = null;
				resolve();
			}
			return result;
		};
		chart_render_patch = { proto, original_render };
	}

	function install_workspace_capture() {
		if (workspace_capture) return;

		const state = {
			original_make_widget: frappe.widget.make_widget,
			charts: [],
			number_cards: [],
		};
		frappe.widget.make_widget = function (opts) {
			const widget = state.original_make_widget(opts);
			try {
				if (widget && opts.widget_type === "chart") {
					state.charts.push(widget);
					ensure_chart_render_is_awaitable(widget);
				} else if (widget && opts.widget_type === "number_card") {
					state.number_cards.push(widget);
				}
			} catch (e) {
				console.error("pos_universal_filter: widget capture failed", e); // eslint-disable-line no-console
			}
			return widget;
		};
		workspace_capture = state;
	}

	function uninstall_workspace_capture() {
		if (!workspace_capture) return;
		frappe.widget.make_widget = workspace_capture.original_make_widget;
		workspace_capture = null;

		if (chart_render_patch) {
			chart_render_patch.proto.render = chart_render_patch.original_render;
			chart_render_patch = null;
		}
	}

	function detach_from_workspace() {
		if (frappe.workspace && frappe.workspace._pospire_filter_bar) {
			frappe.workspace._pospire_filter_bar.$bar.hide();
		}
		uninstall_workspace_capture();
	}

	function attach_to_workspace() {
		const workspace = frappe.workspace;
		install_workspace_capture();

		if (!workspace._pospire_filter_bar) {
			const bar = build_dashboard_bar((company, pos_profile) =>
				apply_filters(
					{ company, pos_profile },
					{
						chart_widgets: workspace_capture.charts,
						number_card_widgets: workspace_capture.number_cards,
						awaitable_charts: true,
					}
				)
			);

			// workspace.js's prepare_container() builds `this.body` (the
			// .layout-main-section) once per session and reuses it across
			// every workspace switch, so prepending here is stable long-term.
			workspace.body.prepend(bar.$bar);
			workspace._pospire_filter_bar = bar;
		}

		const bar = workspace._pospire_filter_bar;
		bar.$bar.show();
		if (!bar.company_field.get_value()) {
			bar.company_field.set_value(frappe.pospire_filter.get_company());
		}
	}

	function is_pospire_workspace_route(route) {
		// Public workspace: ["Workspaces", "POSpire"]. Private (per-user) copy
		// of the same workspace name: ["Workspaces", "private", "POSpire"].
		return (
			route[0] === "Workspaces" &&
			(route[1] === WORKSPACE_NAME ||
				(route[1] === "private" && route[2] === WORKSPACE_NAME))
		);
	}

	frappe.pospire_filter.setup_for_current_page = function () {
		const route = frappe.get_route();
		if (route[0] === "dashboard-view" && route[1] === DASHBOARD_NAME && frappe.dashboard) {
			attach_to_dashboard();
			detach_from_workspace();
		} else if (is_pospire_workspace_route(route) && frappe.workspace) {
			attach_to_workspace();
			detach_from_dashboard();
		} else {
			detach_from_dashboard();
			detach_from_workspace();
		}
	};

	$(document).on("page-change", function () {
		try {
			frappe.pospire_filter.setup_for_current_page();
		} catch (e) {
			console.error("pos_universal_filter: setup_for_current_page failed", e); // eslint-disable-line no-console
		}
	});
})();
