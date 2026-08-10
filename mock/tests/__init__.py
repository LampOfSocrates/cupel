"""Shared helpers for the mock's behavioural tests."""


async def with_turns(c, path: str, **kwargs) -> dict:
    """TEST convenience: a conversation resource stitched to its transcript.

    The wire deliberately keeps the two apart — GET …/conversations/{id} is
    metadata (`turn_count` and no more) and listTurns is a paged collection,
    so opening a long conversation cannot produce an unbounded body. Most
    assertions in this suite are about a conversation AND what was said in
    it, so the join happens once here rather than at thirty call sites.
    page_size is the operation's maximum: these fixtures are short, and a
    test that silently read one page of a longer one would assert nothing.
    """
    conv = (await c.get(path, **kwargs)).json()
    page = (await c.get(f"{path}/turns", params={"page_size": 200}, **kwargs)).json()
    conv["turns"] = page["items"]
    return conv
