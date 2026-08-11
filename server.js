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
    process.env.JWT_SECRET ||
    "CHANGE_THIS_SECRET";

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

if (!process.env.DISCORD_BOT_TOKEN) {
    console.warn(
        "WARNING: DISCORD_BOT_TOKEN is missing. Discord rank synchronization will not work."
    );
}

if (!process.env.DISCORD_GUILD_ID) {
    console.warn(
        "WARNING: DISCORD_GUILD_ID is missing. Discord rank synchronization will not work."
    );
}

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
    discord_id TEXT,
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

if (!columnExists("users", "discord_id")) {
    db.exec(`
        ALTER TABLE users
        ADD COLUMN discord_id TEXT
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
// DISCORD BOT
// ============================================================

const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

// ============================================================
// DISCORD ROLE CONFIGURATION
// ============================================================
//
// Zet de echte role IDs in je .env:
//
// DISCORD_ROLE_CADET=123456789
// DISCORD_ROLE_FIRST_OFFICER=123456789
// etc.
// ============================================================

const DISCORD_ROLE_MAP = {
    "Cadet":
        process.env.DISCORD_ROLE_CADET,

    "First Officer":
        process.env.DISCORD_ROLE_FIRST_OFFICER,

    "Senior First Officer":
        process.env.DISCORD_ROLE_SENIOR_FIRST_OFFICER,

    "Captain":
        process.env.DISCORD_ROLE_CAPTAIN,

    "Senior Captain":
        process.env.DISCORD_ROLE_SENIOR_CAPTAIN,

    "Commander":
        process.env.DISCORD_ROLE_COMMANDER
};

// ============================================================
// DISCORD READY
// ============================================================

discordClient.once(
    "ready",
    () => {
        console.log(
            `Discord bot logged in as ${discordClient.user.tag}`
        );

        console.log(
            `Discord guild ID: ${
                process.env.DISCORD_GUILD_ID || "NOT CONFIGURED"
            }`
        );

        console.log(
            "Discord rank synchronization is enabled."
        );
    }
);

// ============================================================
// DISCORD ERROR
// ============================================================

discordClient.on(
    "error",
    error => {
        console.error(
            "Discord client error:",
            error
        );
    }
);

// ============================================================
// LOGIN DISCORD BOT
// ============================================================

if (process.env.DISCORD_BOT_TOKEN) {
    discordClient
        .login(
            process.env.DISCORD_BOT_TOKEN
        )
        .catch(
            error => {
                console.error(
                    "Could not login Discord bot:",
                    error
                );
            }
        );
}

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

    let current = RANKS[0];
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
// DISCORD RANK SYNCHRONIZATION
// ============================================================
//
// Deze functie:
// 1. Berekent de huidige website rank
// 2. Zoekt de Discord gebruiker
// 3. Verwijdert alle oude Echo Air Group rank roles
// 4. Geeft de juiste nieuwe rank role
//
// ============================================================

async function syncDiscordRank(
    user,
    stars
) {
    try {
        if (!user) {
            return {
                success: false,
                reason: "User not found"
            };
        }

        if (!user.discord_id) {
            console.log(
                `Discord sync skipped for ${user.username}: no Discord ID linked.`
            );

            return {
                success: false,
                reason: "No Discord ID linked"
            };
        }

        if (
            !process.env.DISCORD_BOT_TOKEN ||
            !process.env.DISCORD_GUILD_ID
        ) {
            console.warn(
                "Discord synchronization is not configured."
            );

            return {
                success: false,
                reason: "Discord not configured"
            };
        }

        const rankData =
            getRank(stars);

        const rankName =
            rankData.current.name;

        const newRoleId =
            DISCORD_ROLE_MAP[rankName];

        if (!newRoleId) {
            console.error(
                `No Discord role configured for rank: ${rankName}`
            );

            return {
                success: false,
                reason:
                    `No Discord role configured for ${rankName}`
            };
        }

        if (
            !discordClient.isReady()
        ) {
            console.warn(
                "Discord bot is not ready yet."
            );

            return {
                success: false,
                reason:
                    "Discord bot is not ready"
            };
        }

        const guild =
            await discordClient.guilds.fetch(
                process.env.DISCORD_GUILD_ID
            );

        if (!guild) {
            throw new Error(
                "Discord server could not be found."
            );
        }

        const member =
            await guild.members.fetch(
                user.discord_id
            );

        if (!member) {
            throw new Error(
                `Discord member ${user.discord_id} could not be found.`
            );
        }

        // ====================================================
        // REMOVE ALL OLD ECHO AIR GROUP RANK ROLES
        // ====================================================

        for (
            const roleId
            of Object.values(
                DISCORD_ROLE_MAP
            )
        ) {
            if (!roleId) {
                continue;
            }

            if (
                member.roles.cache.has(
                    roleId
                ) &&
                roleId !== newRoleId
            ) {
                try {
                    await member.roles.remove(
                        roleId
                    );

                    console.log(
                        `Removed old Discord rank role ${roleId} from ${user.username}`
                    );
                } catch (error) {
                    console.error(
                        `Could not remove Discord role ${roleId} from ${user.username}:`,
                        error
                    );
                }
            }
        }

        // ====================================================
        // ADD CURRENT RANK ROLE
        // ====================================================

        if (
            !member.roles.cache.has(
                newRoleId
            )
        ) {
            await member.roles.add(
                newRoleId
            );

            console.log(
                `Discord rank updated: ${user.username} -> ${rankName}`
            );
        } else {
            console.log(
                `Discord rank already correct: ${user.username} -> ${rankName}`
            );
        }

        return {
            success: true,
            rank: rankName,
            roleId: newRoleId
        };
    } catch (error) {
        console.error(
            `Discord rank synchronization failed for ${user.username}:`,
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

    return Math.round(
        value * factor
    ) / factor;
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

function getPilotId(
    flight
) {
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
        id:
            flight.id,

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
        db
            .prepare(`
                SELECT *
                FROM flights
                WHERE user_id = ?
                ORDER BY
                    datetime(dep_time) DESC,
                    id DESC
            `)
            .all(userId);

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
            id:
                user.id,

            username:
                user.username
        },
        JWT_SECRET,
        {
            expiresIn:
                "30d"
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
            db
                .prepare(`
                    SELECT *
                    FROM users
                    WHERE id = ?
                `)
                .get(decoded.id);

        if (!user) {
            return res.status(401).json({
                error:
                    "User not found"
            });
        }

        req.user =
            user;

        next();
    } catch {
        return res.status(401).json({
            error:
                "Invalid or expired token"
        });
    }
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
                discordClient.isReady(),

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

            database:
                "connected",

            discordBot:
                discordClient.isReady(),

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
                db
                    .prepare(`
                        SELECT id
                        FROM users
                        WHERE LOWER(username) =
                              LOWER(?)
                    `)
                    .get(username);

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
                db
                    .prepare(`
                        INSERT INTO users
                        (
                            username,
                            password,
                            display_name
                        )
                        VALUES (?, ?, ?)
                    `)
                    .run(
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
                db
                    .prepare(`
                        SELECT *
                        FROM users
                        WHERE LOWER(username) =
                              LOWER(?)
                    `)
                    .get(username);

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

        // Keep Discord rank synchronized
        await syncDiscordRank(
            req.user,
            stats.stars
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

                discordId:
                    req.user.discord_id ||
                    ""
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
// LINK DISCORD ACCOUNT
// ============================================================
//
// De website kan bijvoorbeeld:
//
// POST /api/account/link-discord
//
// body:
//
// {
//     "discordId": "123456789012345678"
// }
//
// ============================================================

app.post(
    "/api/account/link-discord",
    authenticate,
    async (req, res) => {
        try {
            const discordId =
                String(
                    req.body.discordId ||
                    ""
                ).trim();

            if (!discordId) {
                return res.status(400).json({
                    error:
                        "Discord ID is required."
                });
            }

            // Discord IDs zijn normaal gesproken
            // 17-20 cijfers lang.
            if (
                !/^\d{17,20}$/.test(
                    discordId
                )
            ) {
                return res.status(400).json({
                    error:
                        "Invalid Discord ID."
                });
            }

            db.prepare(`
                UPDATE users
                SET discord_id = ?
                WHERE id = ?
            `).run(
                discordId,
                req.user.id
            );

            const updatedUser =
                db
                    .prepare(`
                        SELECT *
                        FROM users
                        WHERE id = ?
                    `)
                    .get(
                        req.user.id
                    );

            const stats =
                getUserStats(
                    req.user.id
                );

            const discordSync =
                await syncDiscordRank(
                    updatedUser,
                    stats.stars
                );

            res.json({
                message:
                    "Discord account linked successfully.",

                discordId,

                rank:
                    stats.rank.name,

                discordSync
            });
        } catch (error) {
            console.error(
                "Discord link error:",
                error
            );

            res.status(500).json({
                error:
                    "Could not link Discord account."
            });
        }
    }
);

// ============================================================
// UNLINK DISCORD ACCOUNT
// ============================================================

app.post(
    "/api/account/unlink-discord",
    authenticate,
    (req, res) => {
        try {
            db.prepare(`
                UPDATE users
                SET discord_id = NULL
                WHERE id = ?
            `).run(
                req.user.id
            );

            res.json({
                message:
                    "Discord account unlinked successfully."
            });
        } catch (error) {
            console.error(
                "Discord unlink error:",
                error
            );

            res.status(500).json({
                error:
                    "Could not unlink Discord account."
            });
        }
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

const NEWSKY_PAGE_SIZE = 100;

const NEWSKY_RATE_LIMIT_DELAY =
    3500;

const NEWSKY_MAX_RETRIES = 5;

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
            response.status !== 429
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

    if (
        !response.ok
    ) {
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
// EXTRACT FLIGHTS FROM NEWSKY RESPONSE
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
// GET ALL NEWSKY FLIGHTS
// ============================================================

async function getAllNewSkyFlights() {
    const allFlights = [];

    const today =
        toDateOnly(
            new Date()
        );

    let rangeStart =
        toDateOnly(
            NEWSKY_MIN_DATE
        );

    let rangeNumber = 0;

    if (
        rangeStart > today
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
                allFlights.length > 0
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
        db
            .prepare(`
                SELECT
                    id,
                    username,
                    display_name,
                    newsky_pilot_id,
                    discord_id
                FROM users
                WHERE
                    newsky_pilot_id IS NOT NULL
                    AND TRIM(newsky_pilot_id) != ''
            `)
            .all();

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

    const affectedUserIds =
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

                    affectedUserIds.add(
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
                        result.changes > 0
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
            matchedPilots.size,
        affectedUserIds:
            Array.from(
                affectedUserIds
            )
    };
}

// ============================================================
// SYNC DISCORD ROLES FOR AFFECTED USERS
// ============================================================

async function syncAffectedDiscordRanks(
    userIds
) {
    const results = [];

    for (
        const userId
        of userIds
    ) {
        const user =
            db
                .prepare(`
                    SELECT *
                    FROM users
                    WHERE id = ?
                `)
                .get(userId);

        if (!user) {
            continue;
        }

        const stats =
            getUserStats(
                user.id
            );

        const result =
            await syncDiscordRank(
                user,
                stats.stars
            );

        results.push({
            userId:
                user.id,

            username:
                user.username,

            stars:
                stats.stars,

            rank:
                stats.rank.name,

            discord:
                result
        });
    }

    return results;
}

// ============================================================
// GLOBAL SYNC
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
                db
                    .prepare(`
                        SELECT COUNT(*) AS count
                        FROM users
                        WHERE
                            newsky_pilot_id IS NOT NULL
                            AND TRIM(newsky_pilot_id) != ''
                    `)
                    .get()
                    .count;

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

            // Automatically synchronize
            // Discord ranks after flights
            // have been imported.
            const discordResults =
                await syncAffectedDiscordRanks(
                    result.affectedUserIds
                );

            const totalDatabaseFlights =
                db
                    .prepare(`
                        SELECT COUNT(*) AS count
                        FROM flights
                    `)
                    .get()
                    .count;

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

                discordRankSync:
                    discordResults,

                totalFlightsInDatabase:
                    totalDatabaseFlights
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

            // Automatically update Discord
            // after the user's stars/rank change.
            const freshUser =
                db
                    .prepare(`
                        SELECT *
                        FROM users
                        WHERE id = ?
                    `)
                    .get(
                        req.user.id
                    );

            const discordSync =
                await syncDiscordRank(
                    freshUser,
                    stats.stars
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
                    discordSync,

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
// MANUAL DISCORD RANK SYNC
// ============================================================
//
// Handig om vanuit de website een rank opnieuw te synchroniseren.
// POST /api/discord/sync
//
// ============================================================

app.post(
    "/api/discord/sync",
    authenticate,
    async (req, res) => {
        try {
            const stats =
                getUserStats(
                    req.user.id
                );

            const result =
                await syncDiscordRank(
                    req.user,
                    stats.stars
                );

            res.json({
                message:
                    "Discord rank synchronization completed.",

                stars:
                    stats.stars,

                rank:
                    stats.rank.name,

                discord:
                    result
            });
        } catch (error) {
            console.error(
                "Manual Discord sync error:",
                error
            );

            res.status(500).json({
                error:
                    error.message ||
                    "Unable to synchronize Discord rank."
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
                db
                    .prepare(`
                        SELECT
                            id,
                            username,
                            display_name,
                            newsky_pilot_id,
                            discord_id,
                            created_at
                        FROM users
                        ORDER BY
                            LOWER(
                                COALESCE(
                                    display_name,
                                    username
                                )
                            ) ASC
                    `)
                    .all();

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
                                    user.discord_id
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
                db
                    .prepare(`
                        SELECT
                            id,
                            username,
                            display_name,
                            created_at
                        FROM users
                        WHERE id = ?
                    `)
                    .get(
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
                db
                    .prepare(`
                        SELECT
                            id,
                            username,
                            display_name
                        FROM users
                    `)
                    .all();

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
                db
                    .prepare(`
                        SELECT COUNT(*) AS count
                        FROM users
                    `)
                    .get()
                    .count;

            const flights =
                db
                    .prepare(`
                        SELECT COUNT(*) AS count
                        FROM flights
                    `)
                    .get()
                    .count;

            const usersWithFlights =
                db
                    .prepare(`
                        SELECT
                            u.id,
                            u.username,
                            u.newsky_pilot_id,
                            u.discord_id,
                            COUNT(f.id) AS flights
                        FROM users u
                        LEFT JOIN flights f
                            ON f.user_id = u.id
                        GROUP BY u.id
                        ORDER BY u.id
                    `)
                    .all();

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
            return next(error);
        }

        res.status(500).json({
            error:
                "Internal server error"
        });
    }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    () => {
        console.log(
            `Echo Air Group backend running on port ${PORT}`
        );

        console.log(
            `Database: ${DB_PATH}`
        );

        console.log(
            `Discord bot configured: ${Boolean(
                process.env.DISCORD_BOT_TOKEN
            )}`
        );

        console.log(
            `Discord guild configured: ${Boolean(
                process.env.DISCORD_GUILD_ID
            )}`
        );
    }
);
