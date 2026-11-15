# 0016 Site sections: a page has a topic and a page type

**Status:** accepted, 15 Nov 2026 (issue #51). Builds on 0002 and 0014. Plan: "Site sections in the map: plan" (Claude Doc).

**Decision:** every map page carries two things. Its **topic** is its place in the topical map: the hub it hangs under, which decides its links. Its **page type** is the site section it lives in (`siteSection`): which decides its template and URL folder. The topic tree stays the map's backbone; the page type is a label on every page and a second way to view the map. The explorer's Sitemap groups by page type, the Graph stays topical.

- **Sections come from the site, strongest source first:** WordPress post types (with their folder and post categories), main-menu groups for pages at the root (a "Diensten" menu over /dakreparatie/), then URL folders with 2 or more pages. Leftover pages sit in the top level. A section with its own folder goes by the folder's words ("Kennisbank"), not the admin label ("Berichten").
- **Each section gets a generic role:** offer, product, category, audience, place, knowledge, proof, pricing or company. Roles are guessed from data (offerings whose page sits there, pages named after the business's places or audiences, page kinds) and the owner's word in `business.json` (`siteSections`: role, name, ignore) wins. The site's own name is what people see.
- **Rules place every page:** an existing page keeps its section; an offering's page goes to the section for its kind; a local page to the place section; a page for an audience the business serves to the audience section; a question page to the knowledge section and its closest category; else the section of its nearest hub with a page; else the offer section. A role the site lacks becomes a suggested section once 3 or more pages need it.
- **A new page's URL uses its section's folder** (or its category's), not a folder Mycel invents. Articles never nest under an article.
- **Measured by** two `mycel eval map` numbers: pages without a section, new pages outside their section's folder. Both must be 0.

**Why not make the post types the tree:** one topic runs through several types ("Business Central for construction" is a solution page, a sector page, an extension and a dozen articles). A tree by type scatters that topic over four branches, and topical authority comes from those pages linking as one cluster. Round 5 taught the same: /kennisbank/ is a format, not a topic.

**Not yet:** the model proposing roles for sections the data can't place (customer stories), confirmed in the business setup; XML sitemaps as a source; per-client expected placements in the eval.
