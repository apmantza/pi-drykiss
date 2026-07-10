import { execSync } from "node:child_process";

export function uploadPath(name) {
	return `uploads/${name}`;
}

export function deleteUpload(name) {
	try {
		return execSync(`rm -rf uploads/${name}`);
	} catch (error) {
		throw error;
	}
}

export function publicUser(user) {
	return { id: user.id, name: user.name };
}
