const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const {
    Client,
    GatewayIntentBits
} = require("discord.js");

dotenv.config();

const app = express();

// ============================================================
// BASIC CONFIGURATION
// ============================================================

app.use(cors());
app.use(express.json());

const PORT =
    process.env.PORT || 3000;

const JWT_SECRET =
    process.env.JWT_SECRET ||
    "CHANGE_THIS_SECRET";

const DATABASE_URL =
    process.env.DATABASE_URL;

// ============================================================
// ENVIRONMENT CHECKS
// ============================================================

if (!DATABASE_URL) {
    console.error(
        "ERROR: DATABASE_URL is missing."
    );

    process.exit(1);
}

if (!process.env.NEWSKY_API_KEY) {
    console.warn(
        "WARNING: NEWSKY_API_KEY is missing."
    );
}

if (!process.env.JWT_SECRET) {
    console.warn(
        "WARNING: JWT_SECRET is missing. Please set it in Render."
    );
}

// ============================================================
// POSTGRESQL / NEON
// ============================================================

const pool = new Pool({
    connectionString: DATABASE_URL,

    ssl: {
        rejectUnauthorized: false
    },

    max: 5,

    idleTimeoutMillis: 30000,

    connectionTimeoutMillis: 10000
});

async function query(text, params = []) {
    return pool.query(text, params);
}

// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initializeDatabase() {

    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,

            username TEXT UNIQUE NOT NULL,

            password TEXT NOT NULL,

            display_name TEXT,

            newsky_pilot_id TEXT,

            discord_user_id TEXT,

            created_at TIMESTAMPTZ
                DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS flights (
            id SERIAL PRIMARY KEY,

            user_id INTEGER NOT NULL,

            newsky_id TEXT NOT NULL,

            dep_icao TEXT,

            arr_icao TEXT,

            aircraft TEXT,

            rating DOUBLE PRECISION
                DEFAULT 0,

            duration DOUBLE PRECISION
                DEFAULT 0,

            distance DOUBLE PRECISION
                DEFAULT 0,

            stars DOUBLE PRECISION
                DEFAULT 0,

            dep_time TEXT,

            synced_at TIMESTAMPTZ
                DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT flights_user_fk
                FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,

            CONSTRAINT unique_user_flight
                UNIQUE (
                    user_id,
                    newsky_id
                )
        );
    `);

    // --------------------------------------------------------
    // USER MIGRATIONS
    // --------------------------------------------------------

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS display_name TEXT;
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS newsky_pilot_id TEXT;
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS discord_user_id TEXT;
    `);

    // --------------------------------------------------------
    // FLIGHT MIGRATIONS
    // --------------------------------------------------------

    await query(`
        ALTER TABLE flights
        ADD COLUMN IF NOT EXISTS dep_icao TEXT;
    `);

    await query(`
        ALTER TABLE flights
        ADD COLUMN IF NOT EXISTS arr_icao TEXT;
    `);

    await query(`
        ALTER TABLE flights
        ADD COLUMN IF NOT EXISTS aircraft TEXT;
    `);

    await query(`
        ALTER TABLE flights
        ADD COLUMN IF NOT EXISTS rating DOUBLE PRECISION
        DEFAULT 0;
    `);

    await query(`
        ALTER TABLE flights
        ADD COLUMN IF NOT EXISTS duration DOUBLE PRECISION
        DEFAULT 0;
    `);

    await query(`
        ALTER TABLE flights
        ADD COLUMN IF NOT EXISTS distance DOUBLE PRECISION
        DEFAULT 0;
    `);

    await query(`
        ALTER TABLE flights
        ADD COLUMN IF NOT EXISTS stars DOUBLE PRECISION
        DEFAULT 0;
    `);

    await query(`
        ALTER TABLE flights
        ADD COLUMN IF NOT EXISTS dep_time TEXT;
    `);

    await query(`
        ALTER TABLE flights
        ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ
        DEFAULT CURRENT_TIMESTAMP;
    `);

    console.log(
        "PostgreSQL / Neon database ready."
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

function getNewSkyFlightId(flight) {

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
            const key of Object.keys(value)
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

function getDeparture(flight) {

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

    return extractAirportCode(raw);
}

// ============================================================
// ARRIVAL
// ============================================================

function getArrival(flight) {

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

    return extractAirportCode(raw);
}

// ============================================================
// AIRCRAFT
// ============================================================

function getAircraft(flight) {

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

function getRating(flight) {

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

    return toNumber(rating);
}

// ============================================================
// DURATION
// ============================================================

function getDurationMinutes(flight) {

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

        if (parts.length === 2) {

            return (
                parts[0] * 60 +
                parts[1]
            );
        }

        if (parts.length === 3) {

            return (
                parts[0] * 60 +
                parts[1] +
                parts[2] / 60
            );
        }
    }

    return toNumber(value);
}

// ============================================================
// DISTANCE
// ============================================================

function getDistance(flight) {

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

    return toNumber(value);
}

// ============================================================
// DATE
// ============================================================

function getFlightDate(flight) {

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

function formatFlight(flight) {

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

function getAchievements(stats) {

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

async function getUserStats(userId) {

    const result =
        await query(
            `
            SELECT *
            FROM flights
            WHERE user_id = $1
            ORDER BY
                dep_time DESC NULLS LAST,
                id DESC
            `,
            [userId]
        );

    const flights =
        result.rows;

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
            ? ratingTotal / flightCount
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
// AUTHENTICATION
// ============================================================

function createToken(user) {

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

async function authenticate(
    req,
    res,
    next
) {

    const header =
        req.headers.authorization;

    if (
        !header ||
        !header.startsWith("Bearer ")
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

        const result =
            await query(
                `
                SELECT *
                FROM users
                WHERE id = $1
                `,
                [decoded.id]
            );

        const user =
            result.rows[0];

        if (!user) {

            return res.status(401).json({
                error:
                    "User not found"
            });
        }

        req.user =
            user;

        next();

    } catch (error) {

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

let discordReady =
    false;

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

            discordReady =
                true;

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
            error.message
        );

        discordReady =
            false;
    }
}

// ============================================================
// DISCORD ROLE SYNC
// ============================================================

async function syncDiscordRank(userId) {

    if (!discordClient) {

        return {
            success: false,
            reason:
                "Discord bot is not configured."
        };
    }

    if (!discordReady) {

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

    const userResult =
        await query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            `,
            [userId]
        );

    const user =
        userResult.rows[0];

    if (!user) {

        return {
            success: false,
            reason:
                "Website user not found."
        };
    }

    if (!user.discord_user_id) {

        return {
            success: false,
            reason:
                "Discord account is not linked."
        };
    }

    const stats =
        await getUserStats(
            user.id
        );

    const rankName =
        stats.rank.name;

    const targetRoleId =
        DISCORD_ROLE_IDS[
            rankName
        ];

    if (!targetRoleId) {

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

        for (
            const roleId of rankRoleIds
        ) {

            if (
                member.roles.cache.has(roleId) &&
                roleId !== targetRoleId
            ) {

                try {

                    await member.roles.remove(
                        roleId,
                        "Echo Air Group website rank synchronization"
                    );

                } catch (error) {

                    console.error(
                        `Could not remove Discord role ${roleId}:`,
                        error.message
                    );
                }
            }
        }

        if (
            !member.roles.cache.has(
                targetRoleId
            )
        ) {

            await member.roles.add(
                targetRoleId,
                "Echo Air Group website rank synchronization"
            );
        }

        return {

            success: true,

            rank:
                rankName,

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

    const result =
        await query(
            `
            SELECT id
            FROM users
            WHERE
                discord_user_id IS NOT NULL
                AND TRIM(discord_user_id) != ''
            `
        );

    const users =
        result.rows;

    let success = 0;

    let failed = 0;

    for (
        const user of users
    ) {

        const syncResult =
            await syncDiscordRank(
                user.id
            );

        if (syncResult.success) {

            success++;

        } else {

            failed++;
        }

        await sleep(500);
    }

    return {

        total:
            users.length,

        success,

        failed
    };
}

// ============================================================
// ROOT
// ============================================================

app.get(
    "/",
    async (req, res) => {

        res.json({

            message:
                "Echo Air Group backend is running!",

            database:
                "PostgreSQL / Neon",

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
    async (req, res) => {

        try {

            await query(
                "SELECT 1"
            );

            res.json({

                status:
                    "ok",

                database:
                    "connected",

                discordBot:
                    discordReady
                        ? "connected"
                        : "not connected",

                time:
                    new Date().toISOString()
            });

        } catch (error) {

            res.status(500).json({

                status:
                    "error",

                database:
                    "disconnected",

                discordBot:
                    discordReady
                        ? "connected"
                        : "not connected",

                error:
                    error.message
            });
        }
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
                await query(
                    `
                    SELECT id
                    FROM users
                    WHERE LOWER(username) =
                        LOWER($1)
                    `,
                    [username]
                );

            if (
                existing.rows.length
            ) {

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
                await query(
                    `
                    INSERT INTO users
                    (
                        username,
                        password,
                        display_name
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3
                    )
                    RETURNING id, username
                    `,
                    [
                        username,
                        passwordHash,
                        username
                    ]
                );

            const user =
                result.rows[0];

            const token =
                createToken(user);

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

            const result =
                await query(
                    `
                    SELECT *
                    FROM users
                    WHERE LOWER(username) =
                        LOWER($1)
                    `,
                    [username]
                );

            const user =
                result.rows[0];

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
                createToken(user);

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

        try {

            const stats =
                await getUserStats(
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
                    getAchievements(stats),

                /*
                 * IMPORTANT:
                 *
                 * Do NOT use .slice(0, 100) here.
                 *
                 * This endpoint now returns every flight
                 * stored for the logged-in pilot.
                 */
                flights:
                    stats.flights
                        .map(formatFlight)
            });

        } catch (error) {

            console.error(
                "Profile error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to load profile."
            });
        }
    }
);

// ============================================================
// DISCORD OAUTH2 - START
// ============================================================

app.get(
    "/api/discord/login",
    async (req, res) => {

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

            const result =
                await query(
                    `
                    SELECT *
                    FROM users
                    WHERE id = $1
                    `,
                    [decoded.id]
                );

            const user =
                result.rows[0];

            if (!user) {

                return res.status(404).json({
                    error:
                        "Website user not found."
                });
            }

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

            if (
                !code ||
                !state
            ) {

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

            const userResult =
                await query(
                    `
                    SELECT *
                    FROM users
                    WHERE id = $1
                    `,
                    [decoded.userId]
                );

            const user =
                userResult.rows[0];

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
            // EXCHANGE CODE
            // ------------------------------------------------

            const tokenResponse =
                await fetch(
                    "https://discord.com/api/oauth2/token",
                    {
                        method:
                            "POST",

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
            // CHECK EXISTING DISCORD LINK
            // ------------------------------------------------

            const existingUserResult =
                await query(
                    `
                    SELECT id, username
                    FROM users
                    WHERE discord_user_id = $1
                    AND id != $2
                    `,
                    [
                        String(
                            discordUser.id
                        ),

                        user.id
                    ]
                );

            if (
                existingUserResult.rows.length
            ) {

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
            // SAVE DISCORD ID
            // ------------------------------------------------

            await query(
                `
                UPDATE users
                SET discord_user_id = $1
                WHERE id = $2
                `,
                [
                    String(
                        discordUser.id
                    ),

                    user.id
                ]
            );

            console.log(
                `Discord account ${discordUser.username} (${discordUser.id}) linked to website user ${user.username}.`
            );

            // ------------------------------------------------
            // INITIAL RANK SYNC
            // ------------------------------------------------

            const roleSync =
                await syncDiscordRank(
                    user.id
                );

            console.log(
                "Initial Discord rank sync:",
                roleSync
            );

            const stats =
                await getUserStats(
                    user.id
                );

            const rank =
                stats.rank.name;

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
    async (req, res) => {

        try {

            const result =
                await query(
                    `
                    SELECT discord_user_id
                    FROM users
                    WHERE id = $1
                    `,
                    [req.user.id]
                );

            const user =
                result.rows[0];

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

        } catch (error) {

            res.status(500).json({
                error:
                    "Unable to read Discord status."
            });
        }
    }
);

// ============================================================
// MANUAL DISCORD RANK SYNC
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
    async (req, res) => {

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

        try {

            await query(
                `
                UPDATE users
                SET newsky_pilot_id = $1
                WHERE id = $2
                `,
                [
                    cleanId,
                    req.user.id
                ]
            );

            res.json({

                message:
                    "NewSky Pilot ID linked successfully.",

                newskyPilotId:
                    cleanId
            });

        } catch (error) {

            console.error(
                "NewSky linking error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to link NewSky Pilot ID."
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

/*
 * NewSky allows pagination.
 *
 * 100 is NOT the total number of flights.
 * It is simply the number of flights requested per page.
 */
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

function toDateOnly(value) {

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

function minDate(a, b) {

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

    if (!process.env.NEWSKY_API_KEY) {

        throw new Error(
            "NEWSKY_API_KEY is not configured."
        );
    }

    const url =
        "https://newsky.app/api/airline-api/flights/bydate";

    console.log("");
    console.log("NewSky request:");
    console.log("URL:", url);
    console.log("Start:", start);
    console.log("End:", end);
    console.log("Skip:", skip);
    console.log("Count:", count);

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
                        retrySeconds * 1000,
                        10000
                    );
            }
        }

        console.log(
            `Waiting ${Math.round(
                waitTime / 1000
            )} seconds before retry...`
        );

        await sleep(waitTime);
    }

    let data;

    try {

        data =
            JSON.parse(text);

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

function extractFlights(data) {

    if (Array.isArray(data)) {

        return data;
    }

    if (
        data &&
        Array.isArray(data.results)
    ) {

        return data.results;
    }

    if (
        data &&
        Array.isArray(data.flights)
    ) {

        return data.flights;
    }

    if (
        data &&
        data.data &&
        Array.isArray(data.data)
    ) {

        return data.data;
    }

    if (
        data &&
        data.data &&
        Array.isArray(data.data.results)
    ) {

        return data.data.results;
    }

    if (
        data &&
        data.data &&
        Array.isArray(data.data.flights)
    ) {

        return data.data.flights;
    }

    return [];
}

// ============================================================
// GET TOTAL RESULT COUNT FROM NEWSKY RESPONSE
// ============================================================

function getTotalResultCount(data) {

    const possibleValues = [

        firstValue(
            data,
            [
                "totalResults",
                "totalCount",
                "total",
                "count"
            ]
        ),

        data?.data
            ? firstValue(
                data.data,
                [
                    "totalResults",
                    "totalCount",
                    "total",
                    "count"
                ]
            )
            : null,

        data?.meta
            ? firstValue(
                data.meta,
                [
                    "totalResults",
                    "totalCount",
                    "total",
                    "count"
                ]
            )
            : null,

        data?.pagination
            ? firstValue(
                data.pagination,
                [
                    "totalResults",
                    "totalCount",
                    "total"
                ]
            )
            : null
    ];

    for (
        const value of possibleValues
    ) {

        if (
            value !== null &&
            value !== undefined &&
            value !== ""
        ) {

            const number =
                Number(value);

            if (
                Number.isFinite(number) &&
                number >= 0
            ) {

                return number;
            }
        }
    }

    return null;
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
        `Page size: ${NEWSKY_PAGE_SIZE}`
    );
    console.log(
        "============================================================"
    );
    console.log("");

    while (
        rangeStart <=
        today
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

        let rangeFlights = 0;

        while (true) {

            page++;

            /*
             * Respect the NewSky rate limit between requests.
             *
             * We intentionally wait before every request after
             * the first request of the entire sync.
             */
            if (
                allFlights.length > 0
            ) {

                await sleep(
                    NEWSKY_RATE_LIMIT_DELAY
                );
            }

            console.log(
                `Fetching page ${page} | skip=${skip} | count=${NEWSKY_PAGE_SIZE}`
            );

            const data =
                await getNewSkyFlightPage(
                    rangeStart,
                    rangeEnd,
                    skip,
                    NEWSKY_PAGE_SIZE
                );

            const flights =
                extractFlights(data);

            const totalResults =
                getTotalResultCount(data);

            console.log(
                `Received ${flights.length} flight(s)` +
                (
                    totalResults !== null
                        ? ` | total in range: ${totalResults}`
                        : ""
                )
            );

            /*
             * No results means there are no more pages.
             */
            if (
                flights.length === 0
            ) {

                console.log(
                    "No more flights in this date range."
                );

                break;
            }

            allFlights.push(
                ...flights
            );

            rangeFlights +=
                flights.length;

            /*
             * If NewSky tells us the total number of flights
             * and we have reached it, stop.
             */
            if (
                totalResults !== null &&
                skip + flights.length >=
                    totalResults
            ) {

                console.log(
                    `Reached NewSky total of ${totalResults} flight(s).`
                );

                break;
            }

            /*
             * If fewer than PAGE_SIZE flights were returned,
             * this is the final page.
             */
            if (
                flights.length <
                NEWSKY_PAGE_SIZE
            ) {

                console.log(
                    "Final partial page received."
                );

                break;
            }

            /*
             * IMPORTANT:
             *
             * If exactly 100 flights are returned, that does NOT
             * mean there are only 100 flights.
             *
             * Move to the next page.
             */
            skip +=
                flights.length;

            /*
             * Safety protection.
             *
             * Prevent an unexpected API response from causing
             * an infinite pagination loop.
             */
            if (
                page > 10000
            ) {

                throw new Error(
                    `Pagination safety limit reached for ${rangeStart} -> ${rangeEnd}.`
                );
            }
        }

        console.log(
            `Date range complete: ${rangeFlights} flight(s) received.`
        );

        rangeStart =
            addDays(
                rangeEnd,
                1
            );
    }

    /*
     * NewSky data can theoretically contain the same flight
     * more than once across pages/date ranges.
     *
     * Deduplicate by NewSky flight ID.
     */
    const unique =
        new Map();

    let flightsWithoutId =
        0;

    for (
        const flight of allFlights
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

        } else {

            flightsWithoutId++;
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
        `Flights without an ID: ${flightsWithoutId}`
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

async function getLinkedPilotMap() {

    const result =
        await query(
            `
            SELECT
                id,
                username,
                display_name,
                newsky_pilot_id
            FROM users
            WHERE
                newsky_pilot_id IS NOT NULL
                AND TRIM(newsky_pilot_id) != ''
            `
        );

    const users =
        result.rows;

    const map =
        new Map();

    for (
        const user of users
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

async function saveFlight(
    client,
    data
) {

    const result =
        await client.query(
            `
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
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                CURRENT_TIMESTAMP
            )

            ON CONFLICT
            (
                user_id,
                newsky_id
            )

            DO UPDATE SET

                dep_icao =
                    EXCLUDED.dep_icao,

                arr_icao =
                    EXCLUDED.arr_icao,

                aircraft =
                    EXCLUDED.aircraft,

                rating =
                    EXCLUDED.rating,

                duration =
                    EXCLUDED.duration,

                distance =
                    EXCLUDED.distance,

                stars =
                    EXCLUDED.stars,

                dep_time =
                    EXCLUDED.dep_time,

                synced_at =
                    CURRENT_TIMESTAMP

            RETURNING
                (xmax = 0) AS inserted
            `,

            [
                data.userId,
                data.newskyId,
                data.depIcao,
                data.arrIcao,
                data.aircraft,
                data.rating,
                data.duration,
                data.distance,
                data.stars,
                data.depTime
            ]
        );

    return result.rows[0];
}

// ============================================================
// IMPORT ALL FLIGHTS
// ============================================================

async function importAllFlights(
    allFlights
) {

    const pilotMap =
        await getLinkedPilotMap();

    let imported = 0;

    let updated = 0;

    let skipped = 0;

    let unmatched = 0;

    const matchedPilots =
        new Set();

    const client =
        await pool.connect();

    try {

        await client.query(
            "BEGIN"
        );

        for (
            const flight of allFlights
        ) {

            const pilotId =
                getPilotId(flight);

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

            const saveResult =
                await saveFlight(
                    client,
                    {

                        userId:
                            user.id,

                        newskyId,

                        depIcao:
                            departure ||
                            null,

                        arrIcao:
                            arrival ||
                            null,

                        aircraft:
                            aircraft
                                ? String(
                                    aircraft
                                )
                                : null,

                        rating,

                        duration,

                        distance,

                        stars,

                        depTime:
                            depTime
                                ? String(
                                    depTime
                                )
                                : null
                    }
                );

            if (
                saveResult.inserted
            ) {

                imported++;

            } else {

                updated++;
            }
        }

        await client.query(
            "COMMIT"
        );

    } catch (error) {

        await client.query(
            "ROLLBACK"
        );

        throw error;

    } finally {

        client.release();
    }

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

            const linkedResult =
                await query(
                    `
                    SELECT COUNT(*) AS count
                    FROM users
                    WHERE
                        newsky_pilot_id IS NOT NULL
                        AND TRIM(newsky_pilot_id) != ''
                    `
                );

            const linkedPilots =
                Number(
                    linkedResult.rows[0].count
                );

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
                await importAllFlights(
                    allFlights
                );

            console.log(
                "Starting automatic Discord rank synchronization..."
            );

            const discordResult =
                await syncAllDiscordRanks();

            const totalResult =
                await query(
                    `
                    SELECT COUNT(*) AS count
                    FROM flights
                    `
                );

            const totalDatabaseFlights =
                Number(
                    totalResult.rows[0].count
                );

            res.json({

                message:
                    "Echo Air Group flight synchronization completed.",

                newskyFlightsReceived:
                    allFlights.length,

                linkedPilots,

                flightsImported:
                    result.imported,

                flightsUpdated:
                    result.updated,

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
                await importAllFlights(
                    pilotFlights
                );

            const stats =
                await getUserStats(
                    req.user.id
                );

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

                flightsUpdated:
                    result.updated,

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
    async (req, res) => {

        try {

            const result =
                await query(
                    `
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
                    `
                );

            const users =
                result.rows;

            const pilots =
                [];

            for (
                const user of users
            ) {

                const stats =
                    await getUserStats(
                        user.id
                    );

                pilots.push({

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
                });
            }

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
    async (req, res) => {

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

            const result =
                await query(
                    `
                    SELECT
                        id,
                        username,
                        display_name,
                        created_at
                    FROM users
                    WHERE id = $1
                    `,
                    [userId]
                );

            const user =
                result.rows[0];

            if (!user) {

                return res.status(404).json({
                    error:
                        "Pilot not found."
                });
            }

            const stats =
                await getUserStats(
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

                /*
                 * IMPORTANT:
                 *
                 * No .slice(0, 100) here.
                 *
                 * Public pilot profiles now receive
                 * the complete flight history.
                 */
                flights:
                    stats.flights
                        .map(formatFlight)
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
// RECENT FLIGHTS
// ============================================================

app.get(
    "/api/flights/recent",
    async (req, res) => {

        try {

            const result =
                await query(
                    `
                    SELECT
                        f.id,
                        f.newsky_id,
                        f.dep_icao,
                        f.arr_icao,
                        f.aircraft,
                        f.rating,
                        f.duration,
                        f.distance,
                        f.stars,
                        f.dep_time,
                        f.synced_at,

                        u.id AS user_id,
                        u.username,
                        u.display_name

                    FROM flights f

                    LEFT JOIN users u
                        ON u.id = f.user_id

                    WHERE
                        f.dep_time IS NOT NULL

                    ORDER BY
                        f.dep_time DESC

                    LIMIT 3
                    `
                );

            const flights =
                result.rows.map(
                    flight => ({

                        id:
                            flight.id,

                        newskyId:
                            flight.newsky_id,

                        pilotId:
                            flight.user_id,

                        pilot:
                            flight.display_name ||
                            flight.username ||
                            "Unknown Pilot",

                        username:
                            flight.username,

                        departure:
                            flight.dep_icao ||
                            "----",

                        arrival:
                            flight.arr_icao ||
                            "----",

                        aircraft:
                            flight.aircraft ||
                            "Unknown Aircraft",

                        rating:
                            flight.rating !== null
                                ? Number(
                                    flight.rating
                                )
                                : null,

                        duration:
                            flight.duration !== null
                                ? Number(
                                    flight.duration
                                )
                                : null,

                        distance:
                            flight.distance !== null
                                ? Number(
                                    flight.distance
                                )
                                : null,

                        stars:
                            flight.stars !== null
                                ? Number(
                                    flight.stars
                                )
                                : 0,

                        date:
                            flight.dep_time,

                        syncedAt:
                            flight.synced_at
                    })
                );

            res.json({
                flights
            });

        } catch (error) {

            console.error(
                "Recent flights error:",
                error
            );

            res.status(500).json({

                error:
                    "Unable to load recent flights."
            });
        }
    }
);

// ============================================================
// LEADERBOARD
// ============================================================

app.get(
    "/api/ranking",
    async (req, res) => {

        try {

            const result =
                await query(
                    `
                    SELECT
                        id,
                        username,
                        display_name
                    FROM users
                    `
                );

            const users =
                result.rows;

            const rankings =
                [];

            for (
                const user of users
            ) {

                const stats =
                    await getUserStats(
                        user.id
                    );

                rankings.push({

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
                });
            }

            rankings.sort(
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
            );

            rankings.forEach(
                (
                    pilot,
                    index
                ) => {

                    pilot.position =
                        index + 1;
                }
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
    authenticate,
    async (req, res) => {

        try {

            const usersResult =
                await query(
                    `
                    SELECT COUNT(*) AS count
                    FROM users
                    `
                );

            const flightsResult =
                await query(
                    `
                    SELECT COUNT(*) AS count
                    FROM flights
                    `
                );

            const usersWithFlightsResult =
                await query(
                    `
                    SELECT
                        u.id,
                        u.username,
                        u.newsky_pilot_id,
                        u.discord_user_id,
                        COUNT(f.id) AS flights
                    FROM users u
                    LEFT JOIN flights f
                        ON f.user_id = u.id
                    GROUP BY
                        u.id,
                        u.username,
                        u.newsky_pilot_id,
                        u.discord_user_id
                    ORDER BY
                        u.id
                    `
                );

            res.json({

                users:
                    Number(
                        usersResult.rows[0].count
                    ),

                flights:
                    Number(
                        flightsResult.rows[0].count
                    ),

                usersWithFlights:
                    usersWithFlightsResult.rows
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
// NEWSKY SCHEDULED ROUTES
// ============================================================
//
// Loads all scheduled routes from the Echo Air Group
// airline account on NewSky.
//
// NewSky endpoint:
// /api/airline/:airlineId/schedules
//
// The response is an object:
//
// {
//     "0": {...},
//     "1": {...},
//     "2": {...}
// }
//
// This code converts it into:
//
// [
//     {...},
//     {...},
//     {...}
// ]
//
// ============================================================


async function getNewSkySchedules() {

    const airlineId =
        NEWSKY_AIRLINE_ID;

    if (!airlineId) {

        throw new Error(
            "NEWSKY_AIRLINE_ID is not configured."
        );

    }


    /*
     * The schedules endpoint is different from the
     * flight-history endpoint already used elsewhere
     * in this server.
     */

    const url =
        `https://newsky.app/api/airline/${encodeURIComponent(
            airlineId
        )}/schedules`;


    /*
     * NewSky requires authentication for the
     * airline-management schedule endpoint.
     */

    if (!process.env.NEWSKY_API_KEY) {

        throw new Error(
            "NEWSKY_API_KEY is not configured."
        );

    }


    const response =
        await fetch(
            url,
            {
                method: "GET",

                headers: {
                    Authorization:
                        `Bearer ${process.env.NEWSKY_API_KEY}`,

                    Accept:
                        "application/json",

                    "Content-Type":
                        "application/json",

                    "User-Agent":
                        "Echo Air Group Website"
                }
            }
        );


    /*
     * Helpful error handling.
     */

    if (!response.ok) {

        let errorBody =
            "";

        try {

            errorBody =
                await response.text();

        } catch {

            errorBody =
                "";

        }


        throw new Error(
            `NewSky schedules request failed with HTTP ${response.status}` +
            (
                errorBody
                    ? `: ${errorBody.slice(0, 500)}`
                    : ""
            )
        );

    }


    const data =
        await response.json();


    /*
     * NewSky currently returns the schedules
     * as an object whose keys are "0", "1", "2", etc.
     *
     * Object.values() turns that into a clean array.
     */

    let schedules = [];


    if (
        data &&
        typeof data === "object" &&
        !Array.isArray(data)
    ) {

        schedules =
            Object.values(data);

    } else if (
        Array.isArray(data)
    ) {

        schedules =
            data;

    }


    /*
     * Keep only actual schedule objects.
     */

    schedules =
        schedules.filter(
            schedule =>
                schedule &&
                typeof schedule === "object"
        );


    return schedules;

}


// ============================================================
// CALCULATE GREAT-CIRCLE DISTANCE
// ============================================================
//
// NewSky provides latitude and longitude for both airports.
//
// We use the Haversine formula to calculate the route distance.
// Result is returned in kilometres.
//
// ============================================================

function calculateRouteDistanceKm(
    departure,
    arrival
) {

    const lat1 =
        Number(
            departure?.location?.lat
        );

    const lon1 =
        Number(
            departure?.location?.lon
        );

    const lat2 =
        Number(
            arrival?.location?.lat
        );

    const lon2 =
        Number(
            arrival?.location?.lon
        );


    if (
        !Number.isFinite(lat1) ||
        !Number.isFinite(lon1) ||
        !Number.isFinite(lat2) ||
        !Number.isFinite(lon2)
    ) {

        return null;

    }


    const earthRadiusKm =
        6371;


    const toRadians =
        degrees =>
            degrees *
            Math.PI /
            180;


    const dLat =
        toRadians(
            lat2 - lat1
        );

    const dLon =
        toRadians(
            lon2 - lon1
        );


    const a =
        Math.sin(
            dLat / 2
        ) ** 2 +

        Math.cos(
            toRadians(lat1)
        ) *

        Math.cos(
            toRadians(lat2)
        ) *

        Math.sin(
            dLon / 2
        ) ** 2;


    const c =
        2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        );


    return Math.round(
        earthRadiusKm *
        c
    );

}


// ============================================================
// FORMAT NEWSKY SCHEDULE
// ============================================================
//
// Converts the raw NewSky schedule into a stable API format
// for routes.html.
//
// ============================================================

function formatNewSkySchedule(
    schedule
) {

    const departure =
        schedule.dep || {};

    const arrival =
        schedule.arr || {};


    const distance =
        calculateRouteDistanceKm(
            departure,
            arrival
        );


    return {

        id:
            schedule._id ||
            null,


        flightNumber:
            schedule.flightNumber
                ? String(
                    schedule.flightNumber
                )
                : "",


        active:
            Boolean(
                schedule.active
            ),


        type:
            schedule.type ||
            "pax",


        duration:
            Number.isFinite(
                Number(
                    schedule.duration
                )
            )
                ? Number(
                    schedule.duration
                )
                : null,


        weekDays:
            schedule.weekDays &&
            typeof schedule.weekDays === "object"

                ? {

                    mon:
                        Boolean(
                            schedule.weekDays.mon
                        ),

                    tue:
                        Boolean(
                            schedule.weekDays.tue
                        ),

                    wed:
                        Boolean(
                            schedule.weekDays.wed
                        ),

                    thu:
                        Boolean(
                            schedule.weekDays.thu
                        ),

                    fri:
                        Boolean(
                            schedule.weekDays.fri
                        ),

                    sat:
                        Boolean(
                            schedule.weekDays.sat
                        ),

                    sun:
                        Boolean(
                            schedule.weekDays.sun
                        )

                }

                : {

                    mon: false,
                    tue: false,
                    wed: false,
                    thu: false,
                    fri: false,
                    sat: false,
                    sun: false

                },


        airframes:
            Array.isArray(
                schedule.airframes
            )
                ? schedule.airframes.map(
                    value =>
                        String(value)
                )
                : [],


        createdAt:
            schedule.createdAt ||
            null,


        departure: {

            icao:
                departure.icao ||
                "",

            name:
                departure.name ||
                "",

            city:
                departure.city ||
                "",

            location:
                departure.location &&
                typeof departure.location === "object"

                    ? {

                        lat:
                            Number(
                                departure.location.lat
                            ),

                        lon:
                            Number(
                                departure.location.lon
                            ),

                        elev:
                            Number(
                                departure.location.elev
                            )

                    }

                    : null

        },


        arrival: {

            icao:
                arrival.icao ||
                "",

            name:
                arrival.name ||
                "",

            city:
                arrival.city ||
                "",

            location:
                arrival.location &&
                typeof arrival.location === "object"

                    ? {

                        lat:
                            Number(
                                arrival.location.lat
                            ),

                        lon:
                            Number(
                                arrival.location.lon
                            ),

                        elev:
                            Number(
                                arrival.location.elev
                            )

                    }

                    : null

        },


        distanceKm:
            distance

    };

}


// ============================================================
// GET ALL SCHEDULED ROUTES
// ============================================================

app.get(
    "/api/routes",
    async (req, res) => {

        try {

            const schedules =
                await getNewSkySchedules();


            const routes =
                schedules
                    .map(
                        formatNewSkySchedule
                    );


            /*
             * Sort active routes first,
             * then by flight number.
             */

            routes.sort(
                (
                    a,
                    b
                ) => {

                    if (
                        a.active !==
                        b.active
                    ) {

                        return a.active
                            ? -1
                            : 1;

                    }


                    const aNumber =
                        Number(
                            a.flightNumber
                        );

                    const bNumber =
                        Number(
                            b.flightNumber
                        );


                    if (
                        Number.isFinite(aNumber) &&
                        Number.isFinite(bNumber)
                    ) {

                        return (
                            aNumber -
                            bNumber
                        );

                    }


                    return String(
                        a.flightNumber ||
                        ""
                    ).localeCompare(
                        String(
                            b.flightNumber ||
                            ""
                        )
                    );

                }
            );


            res.json({

                airline:
                    "Echo Air Group",


                airlineId:
                    NEWSKY_AIRLINE_ID,


                total:
                    routes.length,


                active:
                    routes.filter(
                        route =>
                            route.active
                    ).length,


                inactive:
                    routes.filter(
                        route =>
                            !route.active
                    ).length,


                updatedAt:
                    new Date().toISOString(),


                routes

            });


        } catch (error) {

            console.error(
                "NewSky schedules error:",
                error
            );


            res.status(500).json({

                error:
                    "Unable to load scheduled routes.",

                details:
                    process.env.NODE_ENV ===
                    "production"

                        ? undefined

                        : error.message

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
// HTML ESCAPE
// ============================================================

function escapeHtml(value) {

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

async function startServer() {

    try {

        await initializeDatabase();

        app.listen(
            PORT,
            async () => {

                console.log(
                    `Echo Air Group backend running on port ${PORT}`
                );

                console.log(
                    "Database: Neon PostgreSQL"
                );

                await startDiscordBot();
            }
        );

    } catch (error) {

        console.error(
            "Failed to start Echo Air Group backend:",
            error
        );

        process.exit(1);
    }
}

startServer();
