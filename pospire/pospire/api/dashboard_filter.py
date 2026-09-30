# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# For license information, please see license.txt

import frappe
from frappe import _

from pospire.boot import eligible_dashboard_companies

DASHBOARD_COMPANY_KEY = "pospire_dashboard_company"


@frappe.whitelist()
def set_dashboard_company(company: str):
	"""
	Remember the Company the user picked in the POSpire dashboard/workspace
	filter bar, so a reload starts on the same company.

	Stored as a per-user default under its own key, never as the Session
	Default "Company" - that one also decides the default company on new
	Sales Invoices and Orders, which a dashboard filter has no business
	changing.

	`_default_dashboard_company()` reads this back as its first step.
	"""

	if company not in eligible_dashboard_companies():
		frappe.throw(_("{0} is not a company you can view the POS dashboard for.").format(company))

	frappe.defaults.set_user_default(DASHBOARD_COMPANY_KEY, company)

	return company


@frappe.whitelist()
def get_new_pos_customers(filters: str | list | None = None):
	"""
	Number of customers created in the last month who have at least one
	submitted POS invoice in the selected company.

	Customer has no company field, so this cannot be a plain Document Type
	number card filtered by company. Counting customers created in the
	period and then keeping only those who actually bought at a POS till
	is what "New Customers via POS" is meant to say.

	`filters` arrives as the card's evaluated filters: a list of
	[doctype, fieldname, operator, value] rows (company only, here).
	"""

	company = _company_from_filters(filters)
	if not company:
		return {"value": 0}

	# get_list, not get_all: a number card counts what the user is allowed to
	# see, the same way Frappe's own Document Type cards do.
	new_customers = frappe.get_list(
		"Customer",
		filters={"creation": [">=", frappe.utils.add_to_date(frappe.utils.nowdate(), months=-1)]},
		pluck="name",
		limit_page_length=0,
	)
	if not new_customers:
		return {"value": 0}

	buyers = frappe.get_list(
		"Sales Invoice",
		filters={
			"customer": ["in", new_customers],
			"company": company,
			"is_pos": 1,
			"docstatus": 1,
		},
		pluck="customer",
		distinct=True,
		limit_page_length=0,
	)

	return {"value": len(set(buyers))}


def _company_from_filters(filters: str | list | dict | None):
	filters = frappe.parse_json(filters) or []

	if isinstance(filters, dict):
		return filters.get("company")

	for row in filters:
		if len(row) >= 4 and row[1] == "company":
			return row[3]

	return None
