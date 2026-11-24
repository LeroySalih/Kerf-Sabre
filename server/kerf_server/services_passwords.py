"""Pupil passwords: two everyday words with a dash, e.g. ``tiger-river`` (docs/ACCOUNTS.md: "Kerf's default is two words";
the teacher issues them on Pupil Cards, pupils do not choose or change them).

397 short, child-friendly words make about 157,212 passwords. That is enough with the per-pupil lockout
and the per-computer throttle in `services_classes.group_login`; the server stores only an scrypt hash, like the old PINs.
"""
from __future__ import annotations

import re
import secrets

WORDS: tuple[str, ...] = tuple("""
    acorn amber anchor angle apple apron arch arrow atlas attic autumn badge bagel baker bamboo banana banjo barn basil
    basket beach beacon beam bean bear beaver bee beetle bell bench berry bike birch bird biscuit bison blanket blaze
    bloom blossom blue boat bolt bonnet boot bottle boulder bowl branch brass bread breeze brick bridge brook broom
    bubble bucket buckle bud buffalo bugle bun bunny butter button cabin cactus cake camel camera camp canal candle
    canoe canyon cape captain caramel card carrot castle cat cedar cello chalk cherry chess chime chip circle clay cliff
    cloud clover coast cobalt cocoa coin comet compass cookie copper coral corn cotton cove crab crane crayon creek
    cricket crown crystal cub cup cupcake daisy dawn deer desert diamond dingo dolphin donkey dove dragon drum duck dune
    eagle earth easel echo elbow elm ember emu engine falcon feather fern ferry fiddle field finch flag flame flint
    flute fog forest fossil fox frog frost fudge galaxy garden garnet gate gecko geyser ginger giraffe glacier globe
    glove goat goose gopher grape grass gravel guitar gull hammer harbour harp hawk hazel heron hill hippo honey hoop
    horse husky igloo indigo iris island ivy jacket jade jaguar jam jelly jet jigsaw juniper kayak kettle kite kiwi
    koala ladder lagoon lake lamp lantern lark lava leaf lemon lentil lily lime linen lion lizard llama lobster locket
    lotus lunar lynx magnet mango maple marble marsh meadow melon meteor mint mitten mole moon moose moss moth mountain
    mouse muffin mule nectar needle nest nickel noodle nutmeg oak oasis ocean olive onion opal orange orbit orchid otter
    owl oyster paddle panda panther paper parrot pasta peach peanut pear pebble pelican penguin pepper piano pickle
    pigeon pillow pine pirate pixel planet plum pocket polar pond pony poppy potato prism puffin pumpkin puppy quail
    quartz quill rabbit raccoon radar radish rain rainbow raven reed reef ribbon river robin rocket rose ruby saddle
    sage sail salmon sand sapphire satchel scarf seal seed shell ship shore silver skate sky sled snail snow sock
    sparrow spider spoon spring spruce squid squirrel star stone stork storm stream sugar summit sun swan sweater swift
    table tiger timber toast toffee tomato topaz torch tortoise toucan tower tractor trail train tree trumpet tulip tuna
    tundra turtle twig umbrella valley velvet violet violin volcano waffle wagon walnut walrus wave whale wheat whistle
    willow window winter wolf wombat wren yak yogurt zebra zinc
""".split())


def new_password() -> str:
    """Two different words, e.g. ``maple-otter``."""
    a = secrets.choice(WORDS)
    b = secrets.choice(WORDS)
    while b == a:
        b = secrets.choice(WORDS)
    return f"{a}-{b}"


def normalise(raw: object) -> str:
    """What a pupil types, the way it was stored: lower case, any spaces, dots or underscores between the words become one dash
    ("Tiger River" and "tiger_river" both mean "tiger-river"). A digits-only PIN from before passwords is unchanged."""
    return re.sub(r"[\s._-]+", "-", str(raw or "").strip().lower()).strip("-")
