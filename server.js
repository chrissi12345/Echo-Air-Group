const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const path = require("path");
const {
    Client,
    GatewayIntentBits
} = require("discord.js");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const JWT_SECRET =
    process.env.JWT_SECRET || "CHANGE_THIS_SECRET";

const DB_PATH =
    process.env.DB_PATH ||
    path.join(__dirname, "echo.db");

// ============================================================
// ENVIRONMENT
// ============================================================

if (!process.env.NEWSKY_API_KEY) {
    console.warn(
        "WARNING: NEWSKY_API_KEY is missing."
    );
}

if (!process.env.JWT_SECRET) {
    console.warn(
        "WARNING: JWT_SECRET is missing. Please set it in your environment."
    );
}

// ============================================================
// DISCORD ENVIRONMENT
// ============================================================

const DISCORD_BOT_TOKEN =
    process.env.DISCORD_BOT_TOKEN || "";

const DISCORD_CLIENT_ID =
    process.env.DISCORD_CLIENT_ID || "";

const DISCORD_CLIENT_SECRET =
    process.env.DISCORD_CLIENT_SECRET || "";

const DISCORD_GUILD_ID =
    process.env.DISCORD_GUILD_ID || "";

const DISCORD_REDIRECT_URI =
    process.env.DISCORD_REDIRECT_URI || "";

// ============================================================
// DISCORD ROLE IDS
// ============================================================

const DISCORD_ROLE_IDS = {
    "Cadet":
        process.env.DISCORD_ROLE_CADET || "",

    "First Officer":
        process.env.DISCORD_ROLE_FIRST_OFFICER || "",

    "Senior First Officer":
        process.env.DISCORD_ROLE_SENIOR_FIRST_OFFICER || "",

    "Captain":
        process.env.DISCORD_ROLE_CAPTAIN || "",

    "Senior Captain":
        process.env.DISCORD_ROLE_SENIOR_CAPTAIN || "",

    "Commander":
        process.env.DISCORD_ROLE_COMMANDER || ""
};

// ============================================================
// DATABASE
// ============================================================

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT,
    newsky_pilot_id TEXT,
    discord_user_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    user_id INTEGER NOT NULL,

    newsky_id TEXT NOT NULL,

    dep_icao TEXT,
    arr_icao TEXT,
    aircraft TEXT,

    rating REAL DEFAULT 0,
    duration REAL DEFAULT 0,
    distance REAL DEFAULT 0,
    stars REAL DEFAULT 0,

    dep_time TEXT,

    synced_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    UNIQUE(user_id, newsky_id)
);
`);

// ============================================================
// DATABASE MIGRATIONS
// ============================================================

function columnExists(table, column) {
    const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all();

    return columns.some(
        item => item.name === column
    );
}

if (!columnExists("users", "display_name")) {
    db.exec(`
        ALTER TABLE users
        ADD COLUMN display_name TEXT
    `);
}

if (!columnExists("users", "newsky_pilot_id")) {
    db.exec(`
        ALTER TABLE users
        ADD COLUMN newsky_pilot_id TEXT
    `);
}

if (!columnExists("users", "discord_user_id")) {
    db.exec(`
        ALTER TABLE users
        ADD COLUMN discord_user_id TEXT
    `);
}

if (!columnExists("flights", "user_id")) {
    throw new Error(
        "The flights table does not contain user_id."
    );
}

console.log(
    "Database ready:",
    DB_PATH
);

// ============================================================
// RANK SYSTEM
// ============================================================

const RANKS = [
    {
        name: "Cadet",
        stars: 0
    },
    {
        name: "First Officer",
        stars: 1000
    },
    {
        name: "Senior First Officer",
        stars: 2500
    },
    {
        name: "Captain",
        stars: 5000
    },
    {
        name: "Senior Captain",
        stars: 7500
    },
    {
        name: "Commander",
        stars: 10000
    }
];

function getRank(stars) {
    const value =
        Number(stars) || 0;

    let current =
        RANKS[0];

    let next = null;

    for (const rank of RANKS) {
        if (value >= rank.stars) {
            current = rank;
        } else {
            next = rank;
            break;
        }
    }

    return {
        current,
        next
    };
}

// ============================================================
// HELPERS
// ============================================================

function toNumber(
    value,
    fallback = 0
) {
    const number =
        Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}

function round(
    value,
    decimals = 2
) {
    const factor =
        Math.pow(
            10,
            decimals
        );

    return (
        Math.round(
            value * factor
        ) / factor
    );
}

function firstValue(
    object,
    keys
) {
    if (
        !object ||
        typeof object !== "object"
    ) {
        return null;
    }

    for (const key of keys) {
        if (
            object[key] !== undefined &&
            object[key] !== null &&
            object[key] !== ""
        ) {
            return object[key];
        }
    }

    return null;
}

// ============================================================
// NEWSKY PILOT ID
// ============================================================

function getPilotId(flight) {
    if (
        !flight ||
        typeof flight !== "object"
    ) {
        return "";
    }

    const direct =
        firstValue(
            flight,
            [
                "pilotId",
                "pilotID",
                "pilot_id",
                "newskyPilotId",
                "newsky_pilot_id"
            ]
        );

    if (direct !== null) {
        return String(
            direct
        ).trim();
    }

    if (
        flight.pilot &&
        typeof flight.pilot === "object"
    ) {
        const nested =
            firstValue(
                flight.pilot,
                [
                    "_id",
                    "id",
                    "pilotId",
                    "pilotID",
                    "newskyPilotId",
                    "newsky_pilot_id"
                ]
            );

        if (nested !== null) {
            return String(
                nested
            ).trim();
        }
    }

    if (
        flight.user &&
        typeof flight.user === "object"
    ) {
        const nested =
            firstValue(
                flight.user,
                [
                    "_id",
                    "id",
                    "pilotId",
                    "pilotID",
                    "pilot_id"
                ]
            );

        if (nested !== null) {
            return String(
                nested
            ).trim();
        }
    }

    if (
        flight.pilotProfile &&
        typeof flight.pilotProfile === "object"
    ) {
        const nested =
            firstValue(
                flight.pilotProfile,
                [
                    "_id",
                    "id",
                    "pilotId",
                    "pilotID",
                    "pilot_id"
                ]
            );

        if (nested !== null) {
            return String(
                nested
            ).trim();
        }
    }

    return "";
}

// ============================================================
// NEWSKY FLIGHT ID
// ============================================================

function getNewSkyFlightId(
    flight
) {
    const value =
        firstValue(
            flight,
            [
                "_id",
                "id",
                "flightId",
                "flightID",
                "flight_id",
                "uuid"
            ]
        );

    if (value === null) {
        return null;
    }

    return String(value);
}

// ============================================================
// AIRPORT CODE
// ============================================================

function extractAirportCode(
    value,
    depth = 0
) {
    if (
        value === null ||
        value === undefined ||
        depth > 6
    ) {
        return null;
    }

    if (
        typeof value === "string"
    ) {
        const text =
            value.trim();

        return text || null;
    }

    if (
        typeof value === "number"
    ) {
        return String(value);
    }

    if (
        typeof value === "object" &&
        !Array.isArray(value)
    ) {
        const directCode =
            firstValue(
                value,
                [
                    "icao",
                    "ICAO",
                    "icaoCode",
                    "ICAOCode",
                    "icao_code",
                    "iata",
                    "IATA",
                    "iataCode",
                    "IATACode",
                    "iata_code",
                    "airportCode",
                    "airport_code",
                    "code",
                    "identifier"
                ]
            );

        if (
            directCode !== null &&
            typeof directCode !== "object"
        ) {
            const code =
                String(
                    directCode
                ).trim();

            if (code) {
                return code;
            }
        }

        const nestedAirport =
            firstValue(
                value,
                [
                    "airport",
                    "Airport",
                    "airportData",
                    "airportInfo",
                    "location"
                ]
            );

        if (
            nestedAirport !== null
        ) {
            const nestedCode =
                extractAirportCode(
                    nestedAirport,
                    depth + 1
                );

            if (nestedCode) {
                return nestedCode;
            }
        }

        for (
            const key
            of Object.keys(value)
        ) {
            const nestedValue =
                value[key];

            if (
                nestedValue === null ||
                nestedValue === undefined
            ) {
                continue;
            }

            if (
                typeof nestedValue === "object"
            ) {
                const nestedCode =
                    extractAirportCode(
                        nestedValue,
                        depth + 1
                    );

                if (nestedCode) {
                    return nestedCode;
                }
            }
        }
    }

    return null;
}

// ============================================================
// DEPARTURE
// ============================================================

function getDeparture(
    flight
) {
    const raw =
        firstValue(
            flight,
            [
                "depIcao",
                "departureIcao",
                "departureICAO",
                "dep_icao",
                "departure",
                "origin",
                "from",
                "dep"
            ]
        );

    return extractAirportCode(
        raw
    );
}

// ============================================================
// ARRIVAL
// ============================================================

function getArrival(
    flight
) {
    const raw =
        firstValue(
            flight,
            [
                "arrIcao",
                "arrivalIcao",
                "arrivalICAO",
                "arr_icao",
                "arrival",
                "destination",
                "to",
                "arr"
            ]
        );

    return extractAirportCode(
        raw
    );
}

// ============================================================
// AIRCRAFT
// ============================================================

function getAircraft(
    flight
) {
    const aircraft =
        firstValue(
            flight,
            [
                "aircraft",
                "aircraftName",
                "aircraftType",
                "aircraftModel",
                "plane",
                "planeName",
                "equipment",
                "aircraftIcao",
                "aircraftICAO",
                "type"
            ]
        );

    if (
        aircraft &&
        typeof aircraft === "object"
    ) {
        return (
            aircraft.name ||
            aircraft.model ||
            aircraft.icao ||
            aircraft.type ||
            "Unknown aircraft"
        );
    }

    return (
        aircraft ||
        "Unknown aircraft"
    );
}

// ============================================================
// RATING
// ============================================================

function getRating(
    flight
) {
    const rating =
        firstValue(
            flight,
            [
                "rating",
                "flightRating",
                "score",
                "grade",
                "performanceRating"
            ]
        );

    return toNumber(
        rating
    );
}

// ============================================================
// DURATION
// ============================================================

function getDurationMinutes(
    flight
) {
    const value =
        firstValue(
            flight,
            [
                "duration",
                "durationMinutes",
                "flightDuration",
                "minutes",
                "flightTime"
            ]
        );

    if (value === null) {
        return 0;
    }

    if (
        typeof value === "string" &&
        value.includes(":")
    ) {
        const parts =
            value
                .split(":")
                .map(Number);

        if (
            parts.length === 2
        ) {
            return (
                parts[0] * 60 +
                parts[1]
            );
        }

        if (
            parts.length === 3
        ) {
            return (
                parts[0] * 60 +
                parts[1] +
                parts[2] / 60
            );
        }
    }

    return toNumber(
        value
    );
}

// ============================================================
// DISTANCE
// ============================================================

function getDistance(
    flight
) {
    const value =
        firstValue(
            flight,
            [
                "distance",
                "distanceKm",
                "distance_km",
                "routeDistance",
                "distanceFlown"
            ]
        );

    return toNumber(
        value
    );
}

// ============================================================
// DATE
// ============================================================

function getFlightDate(
    flight
) {
    return firstValue(
        flight,
        [
            "depTimeAct",
            "depTime",
            "departureTime",
            "departureDate",
            "date",
            "createdAt",
            "flightDate"
        ]
    );
}

// ============================================================
// STAR CALCULATION
// ============================================================

function calculateFlightStars(
    duration,
    distance,
    rating
) {
    const minutes =
        toNumber(duration);

    const km =
        toNumber(distance);

    const flightRating =
        toNumber(rating);

    return round(
        minutes +
        km / 10 +
        flightRating,
        2
    );
}

// ============================================================
// FORMAT FLIGHT
// ============================================================

function formatFlight(
    flight
) {
    return {
        id: flight.id,

        newskyId:
            flight.newsky_id,

        depIcao:
            flight.dep_icao,

        arrIcao:
            flight.arr_icao,

        aircraft:
            flight.aircraft,

        rating:
            round(
                toNumber(
                    flight.rating
                ),
                2
            ),

        duration:
            round(
                toNumber(
                    flight.duration
                ),
                2
            ),

        distance:
            round(
                toNumber(
                    flight.distance
                ),
                2
            ),

        stars:
            round(
                toNumber(
                    flight.stars
                ),
                2
            ),

        depTime:
            flight.dep_time,

        syncedAt:
            flight.synced_at
    };
}

// ============================================================
// ACHIEVEMENTS
// ============================================================

function getAchievements(
    stats
) {
    return [
        {
            id: "first-flight",
            name: "First Flight",
            description:
                "Complete your first flight.",
            icon: "🛫",
            unlocked:
                stats.flightCount >= 1
        },

        {
            id: "airborne",
            name: "Airborne",
            description:
                "Complete 10 flights.",
            icon: "✈️",
            unlocked:
                stats.flightCount >= 10
        },

        {
            id: "pilot",
            name: "Experienced Pilot",
            description:
                "Complete 50 flights.",
            icon: "👨‍✈️",
            unlocked:
                stats.flightCount >= 50
        },

        {
            id: "veteran",
            name: "Veteran Pilot",
            description:
                "Complete 100 flights.",
            icon: "🎖️",
            unlocked:
                stats.flightCount >= 100
        },

        {
            id: "globetrotter",
            name: "Globetrotter",
            description:
                "Fly 10,000 km.",
            icon: "🌍",
            unlocked:
                stats.distance >= 10000
        },

        {
            id: "world-traveler",
            name: "World Traveler",
            description:
                "Fly 50,000 km.",
            icon: "🌎",
            unlocked:
                stats.distance >= 50000
        },

        {
            id: "explorer",
            name: "Explorer",
            description:
                "Fly 100,000 km.",
            icon: "🧭",
            unlocked:
                stats.distance >= 100000
        },

        {
            id: "long-haul",
            name: "Long Hauler",
            description:
                "Fly 100 flight hours.",
            icon: "⏱️",
            unlocked:
                stats.flightHours >= 100
        },

        {
            id: "sky-master",
            name: "Sky Master",
            description:
                "Fly 250 flight hours.",
            icon: "☁️",
            unlocked:
                stats.flightHours >= 250
        },

        {
            id: "five-star",
            name: "Five Star Pilot",
            description:
                "Achieve an average rating of 5.00.",
            icon: "⭐",
            unlocked:
                stats.flightCount > 0 &&
                stats.averageRating >= 5
        },

        {
            id: "first-officer",
            name: "First Officer",
            description:
                "Reach 1,000 stars.",
            icon: "🥇",
            unlocked:
                stats.stars >= 1000
        },

        {
            id: "captain",
            name: "Captain",
            description:
                "Reach 5,000 stars.",
            icon: "🏆",
            unlocked:
                stats.stars >= 5000
        },

        {
            id: "senior-captain",
            name: "Senior Captain",
            description:
                "Reach 7,500 stars.",
            icon: "👑",
            unlocked:
                stats.stars >= 7500
        },

        {
            id: "commander",
            name: "Commander",
            description:
                "Reach 10,000 stars.",
            icon: "🚀",
            unlocked:
                stats.stars >= 10000
        }
    ];
}

// ============================================================
// USER STATS
// ============================================================

function getUserStats(
    userId
) {
    const flights =
        db.prepare(`
            SELECT *
            FROM flights
            WHERE user_id = ?
            ORDER BY
                datetime(dep_time) DESC,
                id DESC
        `).all(userId);

    const flightCount =
        flights.length;

    const stars =
        flights.reduce(
            (
                total,
                flight
            ) =>
                total +
                toNumber(
                    flight.stars
                ),
            0
        );

    const distance =
        flights.reduce(
            (
                total,
                flight
            ) =>
                total +
                toNumber(
                    flight.distance
                ),
            0
        );

    const duration =
        flights.reduce(
            (
                total,
                flight
            ) =>
                total +
                toNumber(
                    flight.duration
                ),
            0
        );

    const ratingTotal =
        flights.reduce(
            (
                total,
                flight
            ) =>
                total +
                toNumber(
                    flight.rating
                ),
            0
        );

    const averageRating =
        flightCount > 0
            ? ratingTotal /
              flightCount
            : 0;

    const flightHours =
        duration / 60;

    const rankData =
        getRank(stars);

    let progress = 100;

    if (rankData.next) {
        progress =
            (
                (
                    stars -
                    rankData.current.stars
                ) /
                (
                    rankData.next.stars -
                    rankData.current.stars
                )
            ) * 100;

        progress =
            Math.max(
                0,
                Math.min(
                    100,
                    progress
                )
            );
    }

    return {
        flights,

        flightCount,

        stars:
            round(
                stars,
                2
            ),

        distance:
            round(
                distance,
                2
            ),

        duration:
            round(
                duration,
                2
            ),

        flightHours:
            round(
                flightHours,
                1
            ),

        averageRating:
            round(
                averageRating,
                2
            ),

        rank:
            rankData.current,

        nextRank:
            rankData.next,

        progress:
            round(
                progress,
                1
            )
    };
}

// ============================================================
// AUTH
// ============================================================

function createToken(
    user
) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username
        },
        JWT_SECRET,
        {
            expiresIn: "30d"
        }
    );
}

function authenticate(
    req,
    res,
    next
) {
    const header =
        req.headers.authorization;

    if (
        !header ||
        !header.startsWith(
            "Bearer "
        )
    ) {
        return res.status(401).json({
            error:
                "Authentication required"
        });
    }

    const token =
        header.substring(7);

    try {
        const decoded =
            jwt.verify(
                token,
                JWT_SECRET
            );

        const user =
            db.prepare(`
                SELECT *
                FROM users
                WHERE id = ?
            `).get(decoded.id);

        if (!user) {
            return res.status(401).json({
                error:
                    "User not found"
            });
        }

        req.user = user;

        next();
    } catch {
        return res.status(401).json({
            error:
                "Invalid or expired token"
        });
    }
}

// ============================================================
// DISCORD BOT
// ============================================================

let discordClient = null;
let discordReady = false;

async function startDiscordBot() {
    if (!DISCORD_BOT_TOKEN) {
        console.warn(
            "Discord bot disabled: DISCORD_BOT_TOKEN is missing."
        );

        return;
    }

    if (!DISCORD_GUILD_ID) {
        console.warn(
            "Discord bot warning: DISCORD_GUILD_ID is missing."
        );
    }

    discordClient =
        new Client({
            intents: [
                GatewayIntentBits.Guilds
            ]
        });

    discordClient.once(
        "ready",
        async () => {
            discordReady = true;

            console.log(
                `Discord bot logged in as ${discordClient.user.tag}`
            );

            if (DISCORD_GUILD_ID) {
                try {
                    const guild =
                        await discordClient.guilds.fetch(
                            DISCORD_GUILD_ID
                        );

                    console.log(
                        `Discord server connected: ${guild.name}`
                    );
                } catch (error) {
                    console.error(
                        "Could not access Discord server:",
                        error.message
                    );
                }
            }
        }
    );

    discordClient.on(
        "error",
        error => {
            console.error(
                "Discord client error:",
                error
            );
        }
    );

    try {
        await discordClient.login(
            DISCORD_BOT_TOKEN
        );
    } catch (error) {
        console.error(
            "Discord bot login failed:",
            error
        );

        discordReady = false;
    }
}

// ============================================================
// DISCORD ROLE SYNC
// ============================================================
//
// Alleen rollen worden aangepast.
// De bot stuurt geen berichten.
//
// ============================================================

async function syncDiscordRank(
    userId
) {
    if (!discordClient) {
        console.log(
            "Discord role sync skipped: bot is not configured."
        );

        return {
            success: false,
            reason:
                "Discord bot is not configured."
        };
    }

    if (!discordReady) {
        console.log(
            "Discord role sync skipped: bot is not ready."
        );

        return {
            success: false,
            reason:
                "Discord bot is not ready."
        };
    }

    if (!DISCORD_GUILD_ID) {
        return {
            success: false,
            reason:
                "DISCORD_GUILD_ID is missing."
        };
    }

    const user =
        db.prepare(`
            SELECT *
            FROM users
            WHERE id = ?
        `).get(userId);

    if (!user) {
        return {
            success: false,
            reason:
                "Website user not found."
        };
    }

    if (!user.discord_user_id) {
        console.log(
            `Discord sync skipped for ${user.username}: Discord account not linked.`
        );

        return {
            success: false,
            reason:
                "Discord account is not linked."
        };
    }

    const stats =
        getUserStats(
            user.id
        );

    const rankName =
        stats.rank.name;

    const targetRoleId =
        DISCORD_ROLE_IDS[
            rankName
        ];

    if (!targetRoleId) {
        console.error(
            `No Discord role ID configured for rank "${rankName}".`
        );

        return {
            success: false,
            reason:
                `No Discord role configured for ${rankName}.`
        };
    }

    try {
        const guild =
            await discordClient.guilds.fetch(
                DISCORD_GUILD_ID
            );

        let member;

        try {
            member =
                await guild.members.fetch(
                    user.discord_user_id
                );
        } catch {
            console.warn(
                `Discord user ${user.discord_user_id} is not in the server.`
            );

            return {
                success: false,
                reason:
                    "Discord user is not a member of the server."
            };
        }

        const rankRoleIds =
            Object.values(
                DISCORD_ROLE_IDS
            ).filter(Boolean);

        // ----------------------------------------------------
        // REMOVE OLD ECHO AIR GROUP RANK ROLES
        // ----------------------------------------------------

        for (
            const roleId
            of rankRoleIds
        ) {
            if (
                member.roles.cache.has(
                    roleId
                ) &&
                roleId !== targetRoleId
            ) {
                try {
                    await member.roles.remove(
                        roleId,
                        "Echo Air Group website rank synchronization"
                    );

                    console.log(
                        `Removed old rank role ${roleId} from ${member.user.tag}`
                    );
                } catch (error) {
                    console.error(
                        `Could not remove Discord role ${roleId}:`,
                        error.message
                    );
                }
            }
        }

        // ----------------------------------------------------
        // ADD CURRENT RANK ROLE
        // ----------------------------------------------------

        if (
            !member.roles.cache.has(
                targetRoleId
            )
        ) {
            await member.roles.add(
                targetRoleId,
                "Echo Air Group website rank synchronization"
            );

            console.log(
                `Added ${rankName} role to ${member.user.tag}`
            );
        } else {
            console.log(
                `${member.user.tag} already has the ${rankName} role.`
            );
        }

        return {
            success: true,
            rank: rankName,
            discordUserId:
                user.discord_user_id,
            roleId:
                targetRoleId
        };
    } catch (error) {
        console.error(
            `Discord role sync error for ${user.username}:`,
            error
        );

        return {
            success: false,
            reason:
                error.message
        };
    }
}

// ============================================================
// SYNC ALL DISCORD RANKS
// ============================================================

async function syncAllDiscordRanks() {
    const users =
        db.prepare(`
            SELECT id
            FROM users
            WHERE
                discord_user_id IS NOT NULL
                AND TRIM(discord_user_id) != ''
        `).all();

    let success = 0;
    let failed = 0;

    for (const user of users) {
        const result =
            await syncDiscordRank(
                user.id
            );

        if (result.success) {
            success++;
        } else {
            failed++;
        }

        // Small delay so Discord API is not hammered.
        await sleep(500);
    }

    return {
        total: users.length,
        success,
        failed
    };
}

// ============================================================
// ROOT
// ============================================================

app.get(
    "/",
    (req, res) => {
        res.json({
            message:
                "Echo Air Group backend is running!",

            database:
                DB_PATH,

            discordBot:
                discordReady
                    ? "connected"
                    : "not connected",

            time:
                new Date().toISOString()
        });
    }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
    "/api/health",
    (req, res) => {
        res.json({
            status: "ok",
            database: "connected",
            discordBot:
                discordReady
                    ? "connected"
                    : "not connected",
            time:
                new Date().toISOString()
        });
    }
);

// ============================================================
// REGISTER
// ============================================================

app.post(
    "/api/auth/register",
    async (req, res) => {
        try {
            let {
                username,
                password
            } = req.body;

            username =
                String(
                    username || ""
                ).trim();

            password =
                String(
                    password || ""
                );

            if (
                !username ||
                !password
            ) {
                return res.status(400).json({
                    error:
                        "Username and password are required"
                });
            }

            if (
                username.length < 3
            ) {
                return res.status(400).json({
                    error:
                        "Username must be at least 3 characters"
                });
            }

            if (
                password.length < 8
            ) {
                return res.status(400).json({
                    error:
                        "Password must be at least 8 characters"
                });
            }

            const existing =
                db.prepare(`
                    SELECT id
                    FROM users
                    WHERE LOWER(username) =
                          LOWER(?)
                `).get(username);

            if (existing) {
                return res.status(409).json({
                    error:
                        "Username already exists. Please choose another username."
                });
            }

            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );

            const result =
                db.prepare(`
                    INSERT INTO users
                    (
                        username,
                        password,
                        display_name
                    )
                    VALUES (?, ?, ?)
                `).run(
                    username,
                    passwordHash,
                    username
                );

            const user = {
                id:
                    result.lastInsertRowid,

                username
            };

            const token =
                createToken(
                    user
                );

            res.status(201).json({
                message:
                    "Account created",

                token
            });
        } catch (error) {
            console.error(
                "Register error:",
                error
            );

            res.status(500).json({
                error:
                    "Could not create account"
            });
        }
    }
);

// ============================================================
// LOGIN
// ============================================================

app.post(
    "/api/auth/login",
    async (req, res) => {
        try {
            const username =
                String(
                    req.body.username || ""
                ).trim();

            const password =
                String(
                    req.body.password || ""
                );

            const user =
                db.prepare(`
                    SELECT *
                    FROM users
                    WHERE LOWER(username) =
                          LOWER(?)
                `).get(username);

            if (!user) {
                return res.status(401).json({
                    error:
                        "Invalid username or password"
                });
            }

            const valid =
                await bcrypt.compare(
                    password,
                    user.password
                );

            if (!valid) {
                return res.status(401).json({
                    error:
                        "Invalid username or password"
                });
            }

            const token =
                createToken(
                    user
                );

            res.json({
                message:
                    "Login successful",

                token
            });
        } catch (error) {
            console.error(
                "Login error:",
                error
            );

            res.status(500).json({
                error:
                    "Could not login"
            });
        }
    }
);

// ============================================================
// MY PROFILE
// ============================================================

app.get(
    "/api/me",
    authenticate,
    async (req, res) => {
        const stats =
            getUserStats(
                req.user.id
            );

        res.json({
            user: {
                id:
                    req.user.id,

                username:
                    req.user.username,

                displayName:
                    req.user.display_name ||
                    req.user.username,

                newskyPilotId:
                    req.user.newsky_pilot_id ||
                    "",

                discordUserId:
                    req.user.discord_user_id ||
                    "",

                discordLinked:
                    Boolean(
                        req.user.discord_user_id
                    )
            },

            stats: {
                stars:
                    stats.stars,

                rank:
                    stats.rank.name,

                rankMin:
                    stats.rank.stars,

                nextRank:
                    stats.nextRank,

                progress:
                    stats.progress,

                flightCount:
                    stats.flightCount,

                distance:
                    stats.distance,

                flightHours:
                    stats.flightHours,

                averageRating:
                    stats.averageRating
            },

            achievements:
                getAchievements(
                    stats
                ),

            flights:
                stats.flights
                    .slice(0, 100)
                    .map(
                        formatFlight
                    )
        });
    }
);

// ============================================================
// DISCORD OAUTH2 - START
// ============================================================
//
// Frontend:
//
// window.location.href =
// API_URL + "/api/discord/login?token=" + token;
//
// ============================================================

app.get(
    "/api/discord/login",
    (req, res) => {
        try {
            if (
                !DISCORD_CLIENT_ID ||
                !DISCORD_CLIENT_SECRET ||
                !DISCORD_REDIRECT_URI
            ) {
                return res.status(500).json({
                    error:
                        "Discord OAuth2 is not configured on the server."
                });
            }

            const token =
                String(
                    req.query.token || ""
                );

            if (!token) {
                return res.status(401).json({
                    error:
                        "Website login token is required."
                });
            }

            let decoded;

            try {
                decoded =
                    jwt.verify(
                        token,
                        JWT_SECRET
                    );
            } catch {
                return res.status(401).json({
                    error:
                        "Invalid or expired website login token."
                });
            }

            const user =
                db.prepare(`
                    SELECT *
                    FROM users
                    WHERE id = ?
                `).get(decoded.id);

            if (!user) {
                return res.status(404).json({
                    error:
                        "Website user not found."
                });
            }

            // ------------------------------------------------
            // STATE
            // ------------------------------------------------
            //
            // State is signed so the callback cannot be used
            // to connect a Discord account to another user.
            //
            const state =
                jwt.sign(
                    {
                        userId:
                            user.id,
                        purpose:
                            "discord-oauth"
                    },
                    JWT_SECRET,
                    {
                        expiresIn:
                            "10m"
                    }
                );

            const params =
                new URLSearchParams({
                    client_id:
                        DISCORD_CLIENT_ID,

                    redirect_uri:
                        DISCORD_REDIRECT_URI,

                    response_type:
                        "code",

                    scope:
                        "identify",

                    state
                });

            const discordUrl =
                `https://discord.com/oauth2/authorize?${params.toString()}`;

            res.redirect(
                discordUrl
            );
        } catch (error) {
            console.error(
                "Discord OAuth start error:",
                error
            );

            res.status(500).json({
                error:
                    "Could not start Discord connection."
            });
        }
    }
);

// ============================================================
// DISCORD OAUTH2 - CALLBACK
// ============================================================

app.get(
    "/api/discord/callback",
    async (req, res) => {
        try {
            const {
                code,
                state,
                error
            } = req.query;

            if (error) {
                return res.status(400).send(`
                    <html>
                    <body style="font-family:Arial;padding:40px">
                        <h2>Discord connection cancelled</h2>
                        <p>You can close this window and return to Echo Air Group.</p>
                    </body>
                    </html>
                `);
            }

            if (!code || !state) {
                return res.status(400).send(`
                    <html>
                    <body style="font-family:Arial;padding:40px">
                        <h2>Discord connection failed</h2>
                        <p>Missing OAuth information.</p>
                    </body>
                    </html>
                `);
            }

            let decoded;

            try {
                decoded =
                    jwt.verify(
                        state,
                        JWT_SECRET
                    );
            } catch {
                return res.status(400).send(`
                    <html>
                    <body style="font-family:Arial;padding:40px">
                        <h2>Discord connection expired</h2>
                        <p>Please try connecting Discord again.</p>
                    </body>
                    </html>
                `);
            }

            if (
                decoded.purpose !==
                "discord-oauth"
            ) {
                return res.status(400).send(`
                    <html>
                    <body style="font-family:Arial;padding:40px">
                        <h2>Invalid Discord connection</h2>
                    </body>
                    </html>
                `);
            }

            const user =
                db.prepare(`
                    SELECT *
                    FROM users
                    WHERE id = ?
                `).get(
                    decoded.userId
                );

            if (!user) {
                return res.status(404).send(`
                    <html>
                    <body style="font-family:Arial;padding:40px">
                        <h2>Website account not found</h2>
                    </body>
                    </html>
                `);
            }

            // ------------------------------------------------
            // EXCHANGE CODE FOR DISCORD ACCESS TOKEN
            // ------------------------------------------------

            const tokenResponse =
                await fetch(
                    "https://discord.com/api/oauth2/token",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/x-www-form-urlencoded"
                        },

                        body:
                            new URLSearchParams({
                                client_id:
                                    DISCORD_CLIENT_ID,

                                client_secret:
                                    DISCORD_CLIENT_SECRET,

                                grant_type:
                                    "authorization_code",

                                code:
                                    String(code),

                                redirect_uri:
                                    DISCORD_REDIRECT_URI
                            })
                    }
                );

            const tokenText =
                await tokenResponse.text();

            let tokenData;

            try {
                tokenData =
                    JSON.parse(
                        tokenText
                    );
            } catch {
                tokenData = {};
            }

            if (
                !tokenResponse.ok ||
                !tokenData.access_token
            ) {
                console.error(
                    "Discord OAuth token error:",
                    tokenData
                );

                return res.status(500).send(`
                    <html>
                    <body style="font-family:Arial;padding:40px">
                        <h2>Discord connection failed</h2>
                        <p>Could not authenticate with Discord.</p>
                    </body>
                    </html>
                `);
            }

            // ------------------------------------------------
            // GET DISCORD USER
            // ------------------------------------------------

            const discordUserResponse =
                await fetch(
                    "https://discord.com/api/users/@me",
                    {
                        headers: {
                            Authorization:
                                `Bearer ${tokenData.access_token}`
                        }
                    }
                );

            const discordUser =
                await discordUserResponse.json();

            if (
                !discordUserResponse.ok ||
                !discordUser.id
            ) {
                console.error(
                    "Discord user lookup failed:",
                    discordUser
                );

                return res.status(500).send(`
                    <html>
                    <body style="font-family:Arial;padding:40px">
                        <h2>Discord connection failed</h2>
                        <p>Could not retrieve your Discord account.</p>
                    </body>
                    </html>
                `);
            }

            // ------------------------------------------------
            // CHECK WHETHER DISCORD ACCOUNT IS ALREADY LINKED
            // ------------------------------------------------

            const existingUser =
                db.prepare(`
                    SELECT id, username
                    FROM users
                    WHERE discord_user_id = ?
                      AND id != ?
                `).get(
                    String(
                        discordUser.id
                    ),
                    user.id
                );

            if (existingUser) {
                return res.status(409).send(`
                    <html>
                    <body style="font-family:Arial;padding:40px">
                        <h2>Discord account already linked</h2>
                        <p>This Discord account is already connected to another Echo Air Group account.</p>
                    </body>
                    </html>
                `);
            }

            // ------------------------------------------------
            // SAVE DISCORD USER ID
            // ------------------------------------------------

            db.prepare(`
                UPDATE users
                SET discord_user_id = ?
                WHERE id = ?
            `).run(
                String(
                    discordUser.id
                ),
                user.id
            );

            console.log(
                `Discord account ${discordUser.username} (${discordUser.id}) linked to website user ${user.username}.`
            );

            // ------------------------------------------------
            // IMMEDIATELY SYNC CURRENT RANK
            // ------------------------------------------------

            const roleSync =
                await syncDiscordRank(
                    user.id
                );

            console.log(
                "Initial Discord rank sync:",
                roleSync
            );

            // ------------------------------------------------
            // SUCCESS PAGE
            // ------------------------------------------------

            const rank =
                getUserStats(
                    user.id
                ).rank.name;

            const discordName =
                discordUser.global_name ||
                discordUser.username;

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>Discord Connected</title>
                </head>

                <body style="
                    margin:0;
                    min-height:100vh;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    background:#f4f7f1;
                    font-family:Arial,sans-serif;
                ">

                    <div style="
                        background:white;
                        padding:40px;
                        border-radius:18px;
                        max-width:500px;
                        text-align:center;
                        box-shadow:0 10px 40px rgba(0,0,0,.08);
                    ">

                        <div style="
                            font-size:55px;
                            margin-bottom:15px;
                        ">✓</div>

                        <h1 style="
                            margin-bottom:10px;
                        ">
                            Discord connected!
                        </h1>

                        <p>
                            Your Echo Air Group account is now connected to
                            <strong>${escapeHtml(discordName)}</strong>.
                        </p>

                        <p>
                            Current rank:
                            <strong>${escapeHtml(rank)}</strong>
                        </p>

                        <p style="
                            color:#667;
                            font-size:14px;
                        ">
                            Your Discord rank role will now be synchronized
                            automatically.
                        </p>

                        <button
                            onclick="window.close()"
                            style="
                                border:0;
                                padding:12px 22px;
                                border-radius:10px;
                                cursor:pointer;
                                background:#ace336;
                                color:#18210f;
                                font-weight:bold;
                            "
                        >
                            Close
                        </button>

                    </div>

                </body>
                </html>
            `);
        } catch (error) {
            console.error(
                "Discord OAuth callback error:",
                error
            );

            res.status(500).send(`
                <html>
                <body style="font-family:Arial;padding:40px">
                    <h2>Discord connection failed</h2>
                    <p>An unexpected error occurred.</p>
                </body>
                </html>
            `);
        }
    }
);

// ============================================================
// DISCORD STATUS
// ============================================================

app.get(
    "/api/discord/status",
    authenticate,
    (req, res) => {
        const user =
            db.prepare(`
                SELECT discord_user_id
                FROM users
                WHERE id = ?
            `).get(
                req.user.id
            );

        res.json({
            connected:
                Boolean(
                    user &&
                    user.discord_user_id
                ),

            discordUserId:
                user?.discord_user_id ||
                null,

            botReady:
                discordReady
        });
    }
);

// ============================================================
// MANUAL DISCORD RANK SYNC
// ============================================================
//
// Handig voor testen.
//
// POST /api/discord/sync
//
// ============================================================

app.post(
    "/api/discord/sync",
    authenticate,
    async (req, res) => {
        try {
            const result =
                await syncDiscordRank(
                    req.user.id
                );

            if (!result.success) {
                return res.status(400).json(
                    result
                );
            }

            res.json({
                message:
                    "Discord rank synchronized.",

                ...result
            });
        } catch (error) {
            console.error(
                "Manual Discord sync error:",
                error
            );

            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

// ============================================================
// LINK NEWSKY ACCOUNT
// ============================================================

app.post(
    "/api/account/link",
    authenticate,
    (req, res) => {
        const cleanId =
            String(
                req.body.newskyPilotId ||
                ""
            ).trim();

        if (!cleanId) {
            return res.status(400).json({
                error:
                    "NewSky Pilot ID is required"
            });
        }

        db.prepare(`
            UPDATE users
            SET newsky_pilot_id = ?
            WHERE id = ?
        `).run(
            cleanId,
            req.user.id
        );

        res.json({
            message:
                "NewSky Pilot ID linked successfully.",

            newskyPilotId:
                cleanId
        });
    }
);

// ============================================================
// NEWSKY CONFIGURATION
// ============================================================

const NEWSKY_AIRLINE_ID =
    process.env.NEWSKY_AIRLINE_ID ||
    "6671c567ed19d758f72965d4";

const NEWSKY_MIN_DATE =
    process.env.NEWSKY_HISTORY_START ||
    "2020-01-01";

const NEWSKY_PAGE_SIZE =
    100;

const NEWSKY_RATE_LIMIT_DELAY =
    3500;

const NEWSKY_MAX_RETRIES =
    5;

// ============================================================
// SLEEP
// ============================================================

function sleep(ms) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

// ============================================================
// DATE HELPERS
// ============================================================

function toDateOnly(
    value
) {
    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        throw new Error(
            `Invalid date: ${value}`
        );
    }

    return date
        .toISOString()
        .slice(0, 10);
}

function addDays(
    dateString,
    days
) {
    const date =
        new Date(
            `${dateString}T00:00:00.000Z`
        );

    date.setUTCDate(
        date.getUTCDate() +
        days
    );

    return date
        .toISOString()
        .slice(0, 10);
}

function minDate(
    a,
    b
) {
    return a < b
        ? a
        : b;
}

// ============================================================
// NEWSKY BYDATE REQUEST
// ============================================================

async function getNewSkyFlightPage(
    start,
    end,
    skip = 0,
    count = NEWSKY_PAGE_SIZE
) {
    if (
        !process.env.NEWSKY_API_KEY
    ) {
        throw new Error(
            "NEWSKY_API_KEY is not configured."
        );
    }

    const url =
        "https://newsky.app/api/airline-api/flights/bydate";

    console.log("");
    console.log(
        "NewSky request:"
    );
    console.log(
        "URL:",
        url
    );
    console.log(
        "Start:",
        start
    );
    console.log(
        "End:",
        end
    );
    console.log(
        "Skip:",
        skip
    );
    console.log(
        "Count:",
        count
    );

    let response;
    let text = "";

    for (
        let attempt = 1;
        attempt <= NEWSKY_MAX_RETRIES;
        attempt++
    ) {
        response =
            await fetch(
                url,
                {
                    method:
                        "POST",

                    headers: {
                        Authorization:
                            `Bearer ${process.env.NEWSKY_API_KEY}`,

                        "Content-Type":
                            "application/json",

                        Accept:
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            skip,
                            count,
                            start,
                            end,
                            includeDeleted:
                                false
                        })
                }
            );

        text =
            await response.text();

        console.log(
            `NewSky HTTP status: ${response.status}`
        );

        if (
            response.status !==
            429
        ) {
            break;
        }

        console.warn(
            `NewSky rate limit reached. Attempt ${attempt}/${NEWSKY_MAX_RETRIES}.`
        );

        const retryAfter =
            response.headers.get(
                "retry-after"
            );

        let waitTime =
            10000;

        if (retryAfter) {
            const retrySeconds =
                Number(
                    retryAfter
                );

            if (
                Number.isFinite(
                    retrySeconds
                )
            ) {
                waitTime =
                    Math.max(
                        retrySeconds *
                            1000,
                        10000
                    );
            }
        }

        console.log(
            `Waiting ${Math.round(
                waitTime / 1000
            )} seconds before retry...`
        );

        await sleep(
            waitTime
        );
    }

    let data;

    try {
        data =
            JSON.parse(
                text
            );
    } catch {
        console.error(
            "Invalid JSON received from NewSky:",
            text
        );

        throw new Error(
            "NewSky returned an invalid JSON response."
        );
    }

    if (!response.ok) {
        console.error(
            "NewSky API error:",
            response.status,
            data
        );

        throw new Error(
            data.error ||
            data.message ||
            `NewSky API returned HTTP ${response.status}`
        );
    }

    return data;
}

// ============================================================
// EXTRACT FLIGHTS
// ============================================================

function extractFlights(
    data
) {
    if (
        Array.isArray(data)
    ) {
        return data;
    }

    if (
        data &&
        Array.isArray(
            data.results
        )
    ) {
        return data.results;
    }

    if (
        data &&
        Array.isArray(
            data.flights
        )
    ) {
        return data.flights;
    }

    if (
        data &&
        data.data &&
        Array.isArray(
            data.data
        )
    ) {
        return data.data;
    }

    if (
        data &&
        data.data &&
        Array.isArray(
            data.data.results
        )
    ) {
        return data.data.results;
    }

    if (
        data &&
        data.data &&
        Array.isArray(
            data.data.flights
        )
    ) {
        return data.data.flights;
    }

    return [];
}

// ============================================================
// GET ALL ECHO AIR GROUP FLIGHTS
// ============================================================

async function getAllNewSkyFlights() {
    const allFlights =
        [];

    const today =
        toDateOnly(
            new Date()
        );

    let rangeStart =
        toDateOnly(
            NEWSKY_MIN_DATE
        );

    let rangeNumber =
        0;

    if (
        rangeStart >
        today
    ) {
        throw new Error(
            `NEWSKY_HISTORY_START (${rangeStart}) cannot be in the future.`
        );
    }

    console.log("");
    console.log(
        "============================================================"
    );
    console.log(
        "STARTING FULL ECHO AIR GROUP NEWSKY SYNC"
    );
    console.log(
        "============================================================"
    );
    console.log(
        `Airline ID: ${NEWSKY_AIRLINE_ID}`
    );
    console.log(
        `History start: ${rangeStart}`
    );
    console.log(
        `History end: ${today}`
    );
    console.log(
        "============================================================"
    );
    console.log("");

    while (
        rangeStart <= today
    ) {
        rangeNumber++;

        const rangeEnd =
            minDate(
                addDays(
                    rangeStart,
                    29
                ),
                today
            );

        console.log("");
        console.log(
            "------------------------------------------------------------"
        );
        console.log(
            `DATE RANGE ${rangeNumber}: ${rangeStart} -> ${rangeEnd}`
        );
        console.log(
            "------------------------------------------------------------"
        );

        let skip = 0;
        let page = 0;

        while (true) {
            page++;

            if (
                allFlights.length >
                0
            ) {
                await sleep(
                    NEWSKY_RATE_LIMIT_DELAY
                );
            }

            console.log(
                `Fetching page ${page} | skip=${skip}`
            );

            const data =
                await getNewSkyFlightPage(
                    rangeStart,
                    rangeEnd,
                    skip,
                    NEWSKY_PAGE_SIZE
                );

            const flights =
                extractFlights(
                    data
                );

            const totalResults =
                toNumber(
                    firstValue(
                        data,
                        [
                            "totalResults",
                            "total",
                            "totalCount"
                        ]
                    ),
                    0
                );

            console.log(
                `Received ${flights.length} flight(s)` +
                (
                    totalResults > 0
                        ? ` | total in range: ${totalResults}`
                        : ""
                )
            );

            if (
                flights.length === 0
            ) {
                break;
            }

            allFlights.push(
                ...flights
            );

            if (
                flights.length <
                NEWSKY_PAGE_SIZE
            ) {
                break;
            }

            if (
                totalResults > 0 &&
                skip +
                    flights.length >=
                    totalResults
            ) {
                break;
            }

            skip +=
                NEWSKY_PAGE_SIZE;
        }

        rangeStart =
            addDays(
                rangeEnd,
                1
            );
    }

    const unique =
        new Map();

    for (
        const flight
        of allFlights
    ) {
        const id =
            getNewSkyFlightId(
                flight
            );

        if (id) {
            unique.set(
                String(id),
                flight
            );
        }
    }

    const result =
        Array.from(
            unique.values()
        );

    console.log("");
    console.log(
        "============================================================"
    );
    console.log(
        "NEWSKY SYNC FINISHED"
    );
    console.log(
        `Raw flights received: ${allFlights.length}`
    );
    console.log(
        `Unique flights: ${result.length}`
    );
    console.log(
        "============================================================"
    );
    console.log("");

    return result;
}

// ============================================================
// USER MAP
// ============================================================

function getLinkedPilotMap() {
    const users =
        db.prepare(`
            SELECT
                id,
                username,
                display_name,
                newsky_pilot_id
            FROM users
            WHERE
                newsky_pilot_id IS NOT NULL
                AND TRIM(newsky_pilot_id) != ''
        `).all();

    const map =
        new Map();

    for (
        const user
        of users
    ) {
        map.set(
            String(
                user.newsky_pilot_id
            ).trim(),
            user
        );
    }

    return map;
}

// ============================================================
// SAVE FLIGHT
// ============================================================

const saveFlight =
    db.prepare(`
        INSERT INTO flights
        (
            user_id,
            newsky_id,
            dep_icao,
            arr_icao,
            aircraft,
            rating,
            duration,
            distance,
            stars,
            dep_time,
            synced_at
        )
        VALUES
        (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            CURRENT_TIMESTAMP
        )

        ON CONFLICT(user_id, newsky_id)
        DO UPDATE SET

            dep_icao =
                excluded.dep_icao,

            arr_icao =
                excluded.arr_icao,

            aircraft =
                excluded.aircraft,

            rating =
                excluded.rating,

            duration =
                excluded.duration,

            distance =
                excluded.distance,

            stars =
                excluded.stars,

            dep_time =
                excluded.dep_time,

            synced_at =
                CURRENT_TIMESTAMP
    `);

// ============================================================
// IMPORT ALL FLIGHTS
// ============================================================

function importAllFlights(
    allFlights
) {
    const pilotMap =
        getLinkedPilotMap();

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let unmatched = 0;

    const matchedPilots =
        new Set();

    const transaction =
        db.transaction(
            flights => {
                for (
                    const flight
                    of flights
                ) {
                    const pilotId =
                        getPilotId(
                            flight
                        );

                    if (!pilotId) {
                        skipped++;
                        continue;
                    }

                    const user =
                        pilotMap.get(
                            String(
                                pilotId
                            ).trim()
                        );

                    if (!user) {
                        unmatched++;
                        continue;
                    }

                    matchedPilots.add(
                        user.id
                    );

                    const newskyId =
                        getNewSkyFlightId(
                            flight
                        );

                    if (!newskyId) {
                        skipped++;
                        continue;
                    }

                    const departure =
                        getDeparture(
                            flight
                        );

                    const arrival =
                        getArrival(
                            flight
                        );

                    const aircraft =
                        getAircraft(
                            flight
                        );

                    const rating =
                        getRating(
                            flight
                        );

                    const duration =
                        getDurationMinutes(
                            flight
                        );

                    const distance =
                        getDistance(
                            flight
                        );

                    const depTime =
                        getFlightDate(
                            flight
                        );

                    const stars =
                        calculateFlightStars(
                            duration,
                            distance,
                            rating
                        );

                    const result =
                        saveFlight.run(
                            user.id,
                            newskyId,
                            departure ||
                                null,
                            arrival ||
                                null,
                            aircraft
                                ? String(
                                      aircraft
                                  )
                                : null,
                            rating,
                            duration,
                            distance,
                            stars,
                            depTime
                                ? String(
                                      depTime
                                  )
                                : null
                        );

                    if (
                        result.changes >
                        0
                    ) {
                        imported++;
                    }
                }
            }
        );

    transaction(
        allFlights
    );

    return {
        imported,
        updated,
        skipped,
        unmatched,
        matchedPilots:
            matchedPilots.size
    };
}

// ============================================================
// SYNC ALL ECHO AIR GROUP FLIGHTS
// ============================================================

app.post(
    "/api/sync/all",
    authenticate,
    async (req, res) => {
        try {
            console.log(
                `Global Echo Air Group flight sync started by user ${req.user.username}`
            );

            const linkedPilots =
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM users
                    WHERE
                        newsky_pilot_id IS NOT NULL
                        AND TRIM(newsky_pilot_id) != ''
                `).get().count;

            if (
                linkedPilots === 0
            ) {
                return res.status(400).json({
                    error:
                        "No Echo Air Group pilots have linked their NewSky Pilot ID yet."
                });
            }

            const allFlights =
                await getAllNewSkyFlights();

            const result =
                importAllFlights(
                    allFlights
                );

            // ------------------------------------------------
            // AUTOMATIC DISCORD RANK SYNC
            // ------------------------------------------------

            console.log(
                "Starting automatic Discord rank synchronization..."
            );

            const discordResult =
                await syncAllDiscordRanks();

            const totalDatabaseFlights =
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM flights
                `).get().count;

            res.json({
                message:
                    "Echo Air Group flight synchronization completed.",

                newskyFlightsReceived:
                    allFlights.length,

                linkedPilots,

                flightsImported:
                    result.imported,

                flightsSkipped:
                    result.skipped,

                flightsWithoutMatchingPilot:
                    result.unmatched,

                pilotsWithFlights:
                    result.matchedPilots,

                totalFlightsInDatabase:
                    totalDatabaseFlights,

                discordRankSync:
                    discordResult
            });
        } catch (error) {
            console.error(
                "Global sync error:",
                error
            );

            res.status(500).json({
                error:
                    error.message ||
                    "Unable to synchronize Echo Air Group flights."
            });
        }
    }
);

// ============================================================
// SYNC MY FLIGHTS
// ============================================================

app.post(
    "/api/sync/me",
    authenticate,
    async (req, res) => {
        try {
            const pilotId =
                String(
                    req.user.newsky_pilot_id ||
                    ""
                ).trim();

            if (!pilotId) {
                return res.status(400).json({
                    error:
                        "Please link your NewSky Pilot ID first."
                });
            }

            console.log(
                `Starting personal flight sync for ${req.user.username} (${pilotId})`
            );

            const allFlights =
                await getAllNewSkyFlights();

            const pilotFlights =
                allFlights.filter(
                    flight =>
                        String(
                            getPilotId(
                                flight
                            )
                        ).trim() ===
                        pilotId
                );

            console.log(
                `Found ${pilotFlights.length} flight(s) for pilot ${pilotId}.`
            );

            const result =
                importAllFlights(
                    pilotFlights
                );

            const stats =
                getUserStats(
                    req.user.id
                );

            // ------------------------------------------------
            // AUTOMATIC DISCORD RANK SYNC
            // ------------------------------------------------

            const discordResult =
                await syncDiscordRank(
                    req.user.id
                );

            res.json({
                message:
                    `${pilotFlights.length} flight(s) found for your NewSky Pilot ID.`,

                newskyFlightsReceived:
                    allFlights.length,

                pilotFlightsFound:
                    pilotFlights.length,

                flightsImported:
                    result.imported,

                flightsSkipped:
                    result.skipped,

                discordRankSync:
                    discordResult,

                stats: {
                    stars:
                        stats.stars,

                    rank:
                        stats.rank.name,

                    flightCount:
                        stats.flightCount,

                    averageRating:
                        stats.averageRating,

                    flightHours:
                        stats.flightHours,

                    distance:
                        stats.distance
                }
            });
        } catch (error) {
            console.error(
                "Personal sync error:",
                error
            );

            res.status(500).json({
                error:
                    error.message ||
                    "Unable to synchronize flights."
            });
        }
    }
);

// ============================================================
// PILOTS
// ============================================================

app.get(
    "/api/pilots",
    (req, res) => {
        try {
            const users =
                db.prepare(`
                    SELECT
                        id,
                        username,
                        display_name,
                        newsky_pilot_id,
                        discord_user_id,
                        created_at
                    FROM users
                    ORDER BY
                        LOWER(
                            COALESCE(
                                display_name,
                                username
                            )
                        ) ASC
                `).all();

            const pilots =
                users.map(
                    user => {
                        const stats =
                            getUserStats(
                                user.id
                            );

                        return {
                            id:
                                user.id,

                            username:
                                user.username,

                            displayName:
                                user.display_name ||
                                user.username,

                            rank:
                                stats.rank.name,

                            stars:
                                stats.stars,

                            flightCount:
                                stats.flightCount,

                            averageRating:
                                stats.averageRating,

                            flightHours:
                                stats.flightHours,

                            distance:
                                stats.distance,

                            newskyLinked:
                                Boolean(
                                    user.newsky_pilot_id
                                ),

                            discordLinked:
                                Boolean(
                                    user.discord_user_id
                                ),

                            createdAt:
                                user.created_at
                        };
                    }
                );

            res.json({
                pilots
            });
        } catch (error) {
            console.error(
                "Pilot list error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to load pilots."
            });
        }
    }
);

// ============================================================
// PUBLIC PILOT PROFILE
// ============================================================

app.get(
    "/api/pilots/:id",
    (req, res) => {
        try {
            const userId =
                Number(
                    req.params.id
                );

            if (
                !Number.isInteger(
                    userId
                )
            ) {
                return res.status(400).json({
                    error:
                        "Invalid pilot ID."
                });
            }

            const user =
                db.prepare(`
                    SELECT
                        id,
                        username,
                        display_name,
                        created_at
                    FROM users
                    WHERE id = ?
                `).get(
                    userId
                );

            if (!user) {
                return res.status(404).json({
                    error:
                        "Pilot not found."
                });
            }

            const stats =
                getUserStats(
                    user.id
                );

            res.json({
                pilot: {
                    id:
                        user.id,

                    username:
                        user.username,

                    displayName:
                        user.display_name ||
                        user.username,

                    rank:
                        stats.rank.name,

                    stars:
                        stats.stars,

                    flightCount:
                        stats.flightCount,

                    averageRating:
                        stats.averageRating,

                    flightHours:
                        stats.flightHours,

                    distance:
                        stats.distance,

                    createdAt:
                        user.created_at
                },

                flights:
                    stats.flights
                        .slice(0, 100)
                        .map(
                            formatFlight
                        )
            });
        } catch (error) {
            console.error(
                "Pilot profile error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to load pilot profile."
            });
        }
    }
);

// ============================================================
// LEADERBOARD
// ============================================================

app.get(
    "/api/ranking",
    (req, res) => {
        try {
            const users =
                db.prepare(`
                    SELECT
                        id,
                        username,
                        display_name
                    FROM users
                `).all();

            const rankings =
                users
                    .map(
                        user => {
                            const stats =
                                getUserStats(
                                    user.id
                                );

                            return {
                                id:
                                    user.id,

                                name:
                                    user.display_name ||
                                    user.username,

                                username:
                                    user.username,

                                stars:
                                    stats.stars,

                                flights:
                                    stats.flightCount,

                                flightCount:
                                    stats.flightCount,

                                averageRating:
                                    stats.averageRating,

                                rank:
                                    stats.rank.name
                            };
                        }
                    )
                    .sort(
                        (
                            a,
                            b
                        ) => {
                            if (
                                b.stars !==
                                a.stars
                            ) {
                                return (
                                    b.stars -
                                    a.stars
                                );
                            }

                            if (
                                b.averageRating !==
                                a.averageRating
                            ) {
                                return (
                                    b.averageRating -
                                    a.averageRating
                                );
                            }

                            return (
                                b.flights -
                                a.flights
                            );
                        }
                    )
                    .map(
                        (
                            pilot,
                            index
                        ) => ({
                            ...pilot,

                            position:
                                index + 1
                        })
                    );

            res.json({
                rankings
            });
        } catch (error) {
            console.error(
                "Ranking error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to load ranking."
            });
        }
    }
);

// ============================================================
// ADMIN DATABASE STATS
// ============================================================

app.get(
    "/api/admin/database-stats",
    (req, res) => {
        try {
            const users =
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM users
                `).get().count;

            const flights =
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM flights
                `).get().count;

            const usersWithFlights =
                db.prepare(`
                    SELECT
                        u.id,
                        u.username,
                        u.newsky_pilot_id,
                        u.discord_user_id,
                        COUNT(f.id) AS flights
                    FROM users u
                    LEFT JOIN flights f
                        ON f.user_id = u.id
                    GROUP BY u.id
                    ORDER BY u.id
                `).all();

            res.json({
                users,
                flights,
                usersWithFlights
            });
        } catch (error) {
            console.error(
                "Database stats error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to read database stats."
            });
        }
    }
);

// ============================================================
// 404
// ============================================================

app.use(
    (req, res) => {
        res.status(404).json({
            error:
                "Endpoint not found",

            path:
                req.originalUrl
        });
    }
);

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
        console.error(
            "Unhandled server error:",
            error
        );

        if (
            res.headersSent
        ) {
            return next(
                error
            );
        }

        res.status(500).json({
            error:
                "Internal server error"
        });
    }
);

// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHtml(
    value
) {
    return String(value)
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}

// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    async () => {
        console.log(
            `Echo Air Group backend running on port ${PORT}`
        );

        console.log(
            `Database: ${DB_PATH}`
        );

        await startDiscordBot();
    }
);
